import React,{useState} from 'react';
import {Input,Field,DropdownSelect,OrganizationPicker,SearchSelect} from '@metro/platform-sdk/ui';

export function PlanFields({form,setForm,categories,categoryOptions,people,peopleLoading,setPeopleSearch,choosePerson,disabled,missingInfo=[]}){
 const [personQuery,setPersonQuery]=useState('');
 const update=(key,value)=>setForm(old=>({...old,[key]:value}));
 return <fieldset className="hct-fields" disabled={disabled}>
  {missingInfo.length>0&&<details className="hct-missing"><summary>整理提示 · {missingInfo.length}</summary><ul>{missingInfo.map((value,index)=><li key={index}>{value}</li>)}</ul></details>}
  <div className="hct-form">
   <Field className="hct-wide" label="计划内容" htmlFor="hct-content"><textarea id="hct-content" className="afc-control afc-control--textarea" maxLength={500} value={form.content} onChange={event=>update('content',event.target.value)}/></Field>
   <Field className="hct-wide" label="完成标准" htmlFor="hct-quality"><textarea id="hct-quality" className="afc-control afc-control--textarea" maxLength={500} value={form.qualityStandard} placeholder="做到什么程度，交付什么成果" onChange={event=>update('qualityStandard',event.target.value)}/></Field>
   <Field className="hct-wide" label="业务模块"><OrganizationPicker label="业务模块" value={form.categoryId} options={categoryOptions} selectable={option=>categories.find(row=>row.id===option.id)?.level===3} onChange={value=>update('categoryId',value)} disabled={disabled} required/></Field>
   <Field label="开始日期" htmlFor="hct-start"><Input id="hct-start" type="date" value={form.startDate} onChange={event=>update('startDate',event.target.value)}/></Field>
   <Field label="完成日期" htmlFor="hct-end"><Input id="hct-end" type="date" value={form.endDate} onChange={event=>update('endDate',event.target.value)}/></Field>
   <Field className="hct-wide" label="责任人" htmlFor="hct-person"><SearchSelect id="hct-person" value={personQuery} options={people.filter(person=>!form.assignees.some(value=>value.personId===person.id)).map(person=>({...person,label:person.name,detail:person.employeeNo}))} onInput={setPersonQuery} onSearch={value=>setPeopleSearch(value.slice(0,100))} onSelect={person=>{choosePerson({...person,organizationId:person.organizationUnitId},true);setPersonQuery('');}} placeholder={form.assignees.length>=6?'已选择 6 人':'搜索姓名，添加责任人'} disabled={disabled||form.assignees.length>=6} allowCustom={false} emptyText={peopleLoading?'正在读取…':'没有可选人员'}/>
    {form.assignees.length>0&&<ul className="hct-persons">{form.assignees.map(person=><li key={person.personId}><button type="button" className="hct-person-lead" title="设为牵头人" aria-pressed={person.isLead} onClick={()=>update('assignees',form.assignees.map(value=>({...value,isLead:value.personId===person.personId})))}>{person.personName??people.find(value=>value.id===person.personId)?.name??person.personId}{person.isLead&&<small>牵头</small>}</button><button type="button" aria-label={`移除${person.personName??'责任人'}`} onClick={()=>choosePerson({id:person.personId},false)}>×</button></li>)}</ul>}
   </Field>
  </div>
  <details className="hct-more"><summary>更多选项{form.remark||form.escalated?' · 已填写':''}</summary><div className="hct-form"><Field label="拟提报中心"><DropdownSelect ariaLabel="拟提报中心" disabled={disabled} value={form.escalated?'yes':'no'} options={[{value:'no',label:'否'},{value:'yes',label:'是'}]} onChange={value=>update('escalated',value==='yes')}/></Field><Field className="hct-wide" label="备注" htmlFor="hct-remark"><Input id="hct-remark" maxLength={500} value={form.remark} onChange={event=>update('remark',event.target.value)}/></Field>{form.originalText&&<p className="hct-muted hct-wide">原话：{form.originalText}</p>}</div></details>
 </fieldset>;
}
