export const templates=[
 {key:'offline-training-sheet',name:'线下培训签到表',subtitle:'安全教育培训记录表',description:'记录培训信息、参训人员和签到情况。',fields:[
  ['department','部门/室','text',true],['workgroupName','工班','text',true],['trainingDate','培训日期','date',true],['trainingTime','培训时间','time',true],['location','培训地点','text',true],['trainingLevel','培训级别','text',false],['trainingHours','培训学时','text',false],['topic','培训主题','text',true],['assessmentType','考核形式','select:考试|抽问',false],['questionSummary','提问摘要','textarea',false],['answerSummary','回答摘要','textarea',false],['instructorId','培训人','person',true]
 ],peopleLabel:'参训人员',peopleRequired:true},
 {key:'competition-score-sheet',name:'技术比武成绩单',subtitle:'部门、工班、年月技术比武成绩单',description:'录入参赛成绩和用时，并由参赛员工、统计人、班组长签字。',fields:[
  ['department','部门/室','text',true],['workgroupName','工班','text',true],['yearMonth','统计年月','month',true],['statisticianId','统计人','person',true],['teamLeaderId','班组长','person',true]
 ],peopleLabel:'参赛人员',peopleRequired:true,scoreRows:true},
 {key:'safety-meeting-ledger',name:'安全会议及活动台账',subtitle:'Q/QD-YZ-FB-AQ-G52-2022-JL001',description:'记录主题、主持、时间、地点和会议内容，由与会人员签字。',fields:[
  ['ledgerCode','表单编号','text',false],['subject','主题','text',true],['hostId','主持人','person',true],['recorderId','记录人','person',true],['location','地点','text',true],['meetingDate','日期','date',true],['recordContent','会议（活动）记录','textarea',false],['retentionNote','保存说明','text',false]
 ],peopleLabel:'与会人员',peopleRequired:true},
 {key:'employee-shift-adjustment',name:'员工调整排班申请表',subtitle:'附录 B · 表 B.1',description:'记录调休或换班安排，完成班组长、车间和部门三级审批签字。',fields:[
  ['department','部门/室','text',true],['applicantId','申请人','person',true],['substituteId','替班人','person',false],['applicationReason','申请事由','textarea',true],['adjustmentType','调整类型','select:调休|换班|法定节假日调班|其他',true],['otherAdjustmentType','其他调整类型','text',false],['adjustedDateText','调整日期','text',true],['adjustedShiftCode','调整班次','select:A1|A2|A3',true],['returnDateText','还班日期','text',false],['returnShiftCode','还班班次','select:A1|A2|A3',false],['teamLeaderId','班组长','person',true],['workshopLeaderId','车间（室）负责人','person',true],['departmentLeaderId','部门负责人','person',true]
 ],peopleLabel:null,peopleRequired:false}
];
export const templateFor=key=>templates.find(item=>item.key===key);
export function validateTemplateData(key,value,selectedIds){
 const template=templateFor(key);if(!template||!value||typeof value!=='object'||Array.isArray(value)||JSON.stringify(value).length>16000)throw Error('INVALID_INPUT');
 const fieldKeys=new Set(template.fields.map(field=>field[0]));if(Object.keys(value).some(field=>!fieldKeys.has(field)))throw Error('INVALID_INPUT');
 const result={};for(const [field,label,type,required] of template.fields){
  const text=value[field]??'';if(typeof text!=='string'||text.length>2000||required&&!text.trim())throw Error('INVALID_INPUT');
  if(type==='textarea'&&text.length>2000||type!=='textarea'&&text.length>240)throw Error('INVALID_INPUT');
  if(type.startsWith('select:')&&text&&!type.slice(7).split('|').includes(text))throw Error('INVALID_INPUT');
  if(type==='date'&&text&&!/^\d{4}-\d{2}-\d{2}$/.test(text)||type==='month'&&text&&!/^\d{4}-\d{2}$/.test(text)||type==='time'&&text&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(text))throw Error('INVALID_INPUT');
  result[field]=text.trim();
 }
 if(key==='employee-shift-adjustment'){
  if(result.adjustmentType==='其他'&&!result.otherAdjustmentType)throw Error('INVALID_INPUT');
  if(result.adjustmentType!=='调休'&&(!result.substituteId||!result.returnDateText||!result.returnShiftCode))throw Error('INVALID_INPUT');
 }
 if(!Array.isArray(selectedIds)||selectedIds.length>100||template.peopleRequired&&!selectedIds.length||selectedIds.some(id=>typeof id!=='string'))throw Error('INVALID_INPUT');
 return result;
}
