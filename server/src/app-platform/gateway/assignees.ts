import {z} from 'zod';
import type {ConnectablePool,QueryableClient} from '../../core/database/index.js';
import {AppBusinessAuthorization} from '../business-authorization/service.js';
import {GatewayError,type AppGatewayOperation} from './model.js';

const input=z.object({permission:z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),search:z.string().max(100).optional(),
 exact:z.boolean().optional(),personId:z.string().uuid().optional(),afterId:z.string().uuid().optional()}).strict();
const row=z.object({id:z.string().uuid(),name:z.string(),employeeNo:z.string(),organizationUnitId:z.string().uuid()});
const page=z.object({rows:z.array(row).max(40),nextCursor:z.string().uuid().nullable()});

/** Search active people under the bound employee's grant for this application action. */
export function createAssigneeDirectoryOperation(pool:ConnectablePool&QueryableClient):AppGatewayOperation {
 const roles=new AppBusinessAuthorization(pool);
 return {name:'platform.people.assignees',permissionCode:'platform.people.read',mode:'read',
  validateParams:value=>input.safeParse(value).success,resolveResources:async()=>[{}],
  async execute(context,value){
   const employee=context.employeeActor;
   if(context.actorType!=='service'||!employee||employee.execution.type!=='application'||employee.execution.appId!==context.execution.appId)throw new GatewayError('ACCESS_DENIED',403);
   const p=input.parse(value),appId=context.execution.appId;
   const grant=(await roles.resolve(appId,employee.person.id))?.grants.find(g=>g.permission===`app.${appId}.${p.permission}`);
   if(!grant)throw new GatewayError('ACCESS_DENIED',403);
   const result=await pool.query(`WITH RECURSIVE active_units AS (
     SELECT id FROM platform_organization_units WHERE parent_id IS NULL AND status='active'
     UNION SELECT u.id FROM platform_organization_units u JOIN active_units a ON u.parent_id=a.id WHERE u.status='active'
    ) SELECT p.id,p.name,p.employee_no AS "employeeNo",p.organization_unit_id AS "organizationUnitId"
    FROM platform_people p JOIN active_units a ON a.id=p.organization_unit_id
    JOIN platform_positions pos ON pos.id=p.position_id AND pos.status='active'
    WHERE p.employment_status='active' AND ($1 OR p.organization_unit_id=ANY($2::uuid[]) OR p.id=$3::uuid)
     AND ($4::uuid IS NULL OR p.id=$4) AND ($5::uuid IS NULL OR p.id>$5)
     AND (CASE WHEN $7 THEN p.name=$6 OR p.employee_no=$6 ELSE
         strpos(lower(p.name),lower($6))>0 OR strpos(lower(p.employee_no),lower($6))>0 END)
    ORDER BY p.id LIMIT 41`,[grant.all,grant.organizationIds,grant.self?employee.person.id:null,p.personId??null,p.afterId??null,p.search?.trim()??'',!!p.exact]) as {rows:z.infer<typeof row>[]};
   return {rows:result.rows.slice(0,40),nextCursor:result.rows.length>40?result.rows[39]!.id:null};
  },validateResult:value=>page.safeParse(value).success,
 };
}
