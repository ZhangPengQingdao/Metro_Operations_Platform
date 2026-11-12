import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {EmployeeIdentityService} from '../src/platform/employee-identity/index.ts';

test('notification badge counts unread recipients in the latest 50 visible messages without fetching bodies',async t=>{
 const db=new PGlite();
 try{
  await db.exec(`CREATE TABLE platform_notifications(id int PRIMARY KEY,status text,read_behavior text,created_at timestamptz DEFAULT now());
   CREATE TABLE platform_notification_recipients(notification_id int,person_id text);
   CREATE TABLE platform_notification_reads(notification_id int,person_id text,read_at timestamptz);
   INSERT INTO platform_notifications SELECT i,'active','mark_read' FROM generate_series(1,60) i;
   INSERT INTO platform_notifications VALUES (61,'cancelled','mark_read'),(62,'archived','mark_read'),(63,'active','state_bound'),(64,'active','mark_read');
   INSERT INTO platform_notification_recipients SELECT i,'self' FROM generate_series(1,63) i;
   INSERT INTO platform_notification_recipients VALUES(64,'other');
   INSERT INTO platform_notification_reads VALUES(60,'self',now()),(63,'self',now()),(59,'other',now());`);
  const client={query:(sql:string,values?:readonly unknown[])=>db.query(sql,values?[...values]:undefined),release(){}};
  const service=new EmployeeIdentityService({...client,connect:async()=>client} as never);
  const authenticate=t.mock.method(service,'authenticate',async(token?:string)=>token==='valid'?{personId:'self'} as any:null);
  assert.deepEqual(await service.notificationUnreadCount('valid'),{count:49});
  await assert.rejects(service.notificationUnreadCount(),/EMPLOYEE_AUTH_REQUIRED/);
  let checks=0;
  authenticate.mock.mockImplementation(async()=>++checks===1?{personId:'self'} as any:null);
  await assert.rejects(service.notificationUnreadCount('revoked-during-read'),/EMPLOYEE_AUTH_REQUIRED/);
 }finally{await db.close();}
});
