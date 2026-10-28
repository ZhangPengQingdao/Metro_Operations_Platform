import {useEffect,useState} from 'react';
import {Input,Field,DropdownSelect,SearchSelect} from '@metro/platform-sdk/ui';

export function PersonField({form,setForm,session,organizationId,call,disabled,id='responsible'}){
 const teams=session.workgroups.filter(team=>team.departmentId===organizationId),[teamId,setTeamId]=useState(form.responsible?.organizationUnitId??session.organizationId),[query,setQuery]=useState(form.responsible?.name??''),[search,setSearch]=useState(''),[people,setPeople]=useState([]),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const selectedTeam=teams.some(team=>team.id===teamId)?teamId:teams[0]?.id;
 useEffect(()=>{if(!selectedTeam)return;let alive=true;setPeople([]);setLoading(true);call('members',{organizationId,workgroupId:selectedTeam,...(search?{search}:{})}).then(page=>{if(alive){setPeople(page.rows);setError('');}}).catch(error=>{if(alive)setError(error.message);}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};},[selectedTeam,search,organizationId,call]);
 return <Field className="hct-wide" label="责任人" required htmlFor={id}>
  <div className="hct-person-field">{teams.length>1&&<DropdownSelect ariaLabel="责任人所在工班" value={selectedTeam??''} options={teams.map(team=>({value:team.id,label:team.name}))} disabled={disabled} onChange={value=>{setTeamId(value);setSearch('');setQuery('');setPeople([]);setForm(old=>({...old,responsible:null,annualId:''}));}}/>}
  <SearchSelect key={selectedTeam} id={id} value={query} options={people.map(person=>({...person,label:person.name,detail:person.employeeNo}))} allowCustom={false} required disabled={disabled||!selectedTeam} placeholder="搜索并选择责任人" emptyText={loading?'正在读取…':'没有匹配人员'} onInput={value=>{setQuery(value);setForm(old=>({...old,responsible:null,annualId:''}));}} onSearch={setSearch} onSelect={person=>{setQuery(person.name);setForm(old=>({...old,annualId:old.responsible?.personId===person.id?old.annualId:'',responsible:{personId:person.id,organizationUnitId:person.organizationUnitId,name:person.name}}));}}/></div>{error&&<p role="alert" className="hct-alert">{error}</p>}
 </Field>;
}
export function PlanFields({form,setForm,session,organizationId,call,disabled,kind='monthly',missingInfo=[],hints=[]}){
 const update=(key,value)=>setForm(old=>({...old,[key]:value}));
 return <fieldset className="hct-fields" disabled={disabled}>
  <>{missingInfo.length>0&&<aside className="hct-notice" role="status"><strong>请核对并补充</strong><ul>{missingInfo.map((item,index)=><li key={index}>{item}</li>)}</ul></aside>}<div className="hct-form">
   <Field className="hct-wide" label={kind==='supervision'?'督办要求':'工作计划内容'} required htmlFor="hct-content"><textarea id="hct-content" className="afc-control afc-control--textarea" maxLength={500} required value={form.content} onChange={e=>update('content',e.target.value)}/></Field>
   {kind!=='annual'&&<Field className="hct-wide" label={kind==='supervision'?'办结标准':'完成质量标准'} required htmlFor="hct-quality"><textarea id="hct-quality" className="afc-control afc-control--textarea" maxLength={500} required value={form.qualityStandard} onChange={e=>update('qualityStandard',e.target.value)}/></Field>}
   {kind==='monthly'&&<Field label="开始日期" required htmlFor="hct-start"><Input required id="hct-start" type="date" max={form.endDate||undefined} value={form.startDate} onChange={e=>update('startDate',e.target.value)}/></Field>}
   {kind!=='annual'&&<Field label={kind==='supervision'?'督办时限':'完成日期'} required htmlFor="hct-end"><Input required id="hct-end" type="date" min={kind==='monthly'?form.startDate||undefined:undefined} value={form.endDate} onChange={e=>update('endDate',e.target.value)}/></Field>}
   {kind==='annual'&&<><Field label="年度" required htmlFor="hct-year"><Input required id="hct-year" type="number" min="2000" max="2100" value={form.year} onChange={e=>update('year',Number(e.target.value))}/></Field><Field label="开始月份" required htmlFor="hct-start-month"><Input required id="hct-start-month" type="number" min="1" max="12" value={form.startMonth} onChange={e=>update('startMonth',Number(e.target.value))}/></Field><Field label="结束月份" required htmlFor="hct-end-month"><Input required id="hct-end-month" type="number" min={form.startMonth||1} max="12" value={form.endMonth} onChange={e=>update('endMonth',Number(e.target.value))}/></Field></>}
   <PersonField form={form} setForm={setForm} session={session} organizationId={organizationId} call={call} disabled={disabled}/>
   {kind==='monthly'&&hints.length>0&&<Field className="hct-wide" label="关联年度计划（可选）"><DropdownSelect ariaLabel="关联年度计划" disabled={disabled} value={form.annualId??''} options={[{value:'',label:'不关联'},...hints.filter(row=>!form.responsible||row.responsible_id===form.responsible.personId).map(row=>({value:row.id,label:row.content}))]} onChange={value=>update('annualId',value)}/></Field>}
   {kind==='supervision'&&<Field className="hct-wide" label="备注" htmlFor="hct-remark"><textarea id="hct-remark" className="afc-control afc-control--textarea" value={form.remark??''} maxLength={500} onChange={e=>update('remark',e.target.value)}/></Field>}
  </div></>
 </fieldset>;
}
