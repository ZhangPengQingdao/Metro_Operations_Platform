import type {QueryableClient} from '../../core/database/index.js';

type PendingRow={id:string;name:string;createdAt:string;total:string};
const rows=async<T>(db:QueryableClient,sql:string)=>((await db.query(sql)) as {rows:T[]}).rows;

export async function pendingReviewNotifications(db:QueryableClient){
 const apps=await rows<PendingRow&{version:string;kind:'new'|'update'}>(db,`
  SELECT id,name,version,kind,created_at AS "createdAt",count(*) OVER()::text AS total
  FROM platform_app_submissions WHERE status='pending' ORDER BY created_at DESC,id DESC LIMIT 20`);
 const registrations=await rows<PendingRow>(db,`
  SELECT id,name,created_at AS "createdAt",count(*) OVER()::text AS total
  FROM platform_employee_registrations WHERE status='pending' ORDER BY created_at,id LIMIT 20`);
 return {
  total:Number(apps[0]?.total??0)+Number(registrations[0]?.total??0),
  notifications:[
   ...apps.map(row=>({id:`app-submission:${row.id}`,title:`${row.name} · ${row.kind==='new'?'上架申请':'更新申请'}`,description:`版本 ${row.version} 待审核`,path:`/admin/apps/submissions?submission=${row.id}`,createdAt:row.createdAt})),
   ...registrations.map(row=>({id:`employee-registration:${row.id}`,title:`${row.name} · 员工注册申请`,description:'待审核',path:'/admin/accounts/registrations',createdAt:row.createdAt}))
  ]
 };
}
