import React from 'react';
import {QueryList,TableHeader,TableBody,TableRow,TableHead,TableCell,TableActions,TableActionButton,Plus,Trash} from '@metro/platform-sdk/ui';

const matches=(search,...values)=>!search||values.some(value=>String(value??'').toLocaleLowerCase().includes(search.toLocaleLowerCase()));

export function WorkflowList({view,query,categories,bindings,items,people,can,busy,loading,previewRows,columns,runWrite,openBinding}){
 const search=query.searchValue;
 const personName=row=>row.person_name??people.find(person=>person.id===row.person_id)?.name??row.person_id;
 let headers,rows,body;
 if(view==='bindings'){
  headers=['业务分类','归口人','操作'];
  rows=categories.filter(row=>row.level===2&&row.enabled&&matches(search,row.name,...bindings.filter(binding=>binding.category_id===row.id).map(personName)));
  body=rows.map(row=><TableRow key={row.id}><TableCell>{row.name}</TableCell><TableCell className="hct-wrap">{bindings.filter(binding=>binding.category_id===row.id).map(personName).join('、')||'未配置'}</TableCell><TableCell><TableActions>{can('manage')&&<><TableActionButton icon={<Plus size={18}/>} disabled={busy} onClick={()=>openBinding(row.id)}>增加</TableActionButton>{bindings.filter(binding=>binding.category_id===row.id).map(binding=><TableActionButton key={binding.id} icon={<Trash size={18}/>} disabled={busy} onClick={()=>runWrite('binding-delete',{id:binding.id})}>移除 {personName(binding)}</TableActionButton>)}</>}</TableActions></TableCell></TableRow>);
 }else{
  headers=columns;
  rows=previewRows(items.filter(row=>matches(search,row.content,row.quality_standard,row.root_name,row.parent_name,row.category_name,...(row.assignees??[]).map(person=>person.personName))));
  body=rows.map((row,index)=><TableRow key={index}>{row.map((cell,column)=><TableCell key={column} className={[4,5,9].includes(column)?'hct-wrap':undefined}>{cell}</TableCell>)}</TableRow>);
 }
 return <QueryList query={query} pinActions={view!=='preview'} emptyState={loading?'加载中…':!rows.length?view==='bindings'?'暂无符合条件的业务分类':'暂无符合条件的计划':undefined}>
  <TableHeader><TableRow>{headers.map(label=><TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader>
  <TableBody>{body}</TableBody>
 </QueryList>;
}
