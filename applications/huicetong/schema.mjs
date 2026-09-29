const column=(name,type,nullable=false)=>({name,type,nullable});
const table=(name,columns)=>({kind:'createTable',table:name,columns:[column('id','uuid'),...columns],primaryKey:['id']});
const index=(table,name,columns,unique=false)=>({kind:'createIndex',table,name,columns,...(unique?{unique:true}:{})});
const common=[column('organization_id','uuid'),column('created_at','timestamptz')];

/** P0 schema is declared once; later changes can only add nullable columns or tables. */
export const migration={migrationVersion:'1.0',operations:[
 table('plan_cycles',[...common,column('year','integer'),column('month','integer'),column('status','text'),column('fill_deadline','date',true),column('created_by','uuid'),column('updated_at','timestamptz'),column('revision','integer'),column('intent_id','uuid')]),
 table('category_nodes',[column('organization_id','uuid'),column('parent_id','uuid',true),column('level','integer'),column('name','text'),column('sort','integer'),column('enabled','boolean'),column('created_at','timestamptz'),column('updated_at','timestamptz'),column('revision','integer')]),
 table('plan_items',[column('organization_id','uuid'),column('cycle_id','uuid'),column('category_id','uuid'),column('root_name','text'),column('parent_name','text'),column('category_name','text'),column('content','text'),column('quality_standard','text'),column('start_date','date'),column('end_date','date'),column('status','text'),column('source','text'),column('supervision_entry_id','uuid',true),column('escalated','boolean'),column('remark','text',true),column('lead_person_id','uuid'),column('assignees','jsonb'),column('created_by','uuid'),column('created_at','timestamptz'),column('updated_at','timestamptz'),column('version','integer'),column('intent_id','uuid')]),
 table('plan_item_assignees',[column('organization_id','uuid'),column('item_id','uuid'),column('person_id','uuid'),column('person_organization_id','uuid'),column('person_name','text'),column('is_lead','boolean'),column('sort','integer')]),
 table('review_records',[...common,column('cycle_id','uuid'),column('item_id','uuid'),column('reviewer_id','uuid'),column('action','text'),column('comment','text',true)]),
 table('completion_records',[column('organization_id','uuid'),column('item_id','uuid'),column('summary','text'),column('status','text'),column('submitted_by','uuid'),column('submitted_at','timestamptz'),column('confirmed_by','uuid',true),column('confirmed_at','timestamptz',true),column('reject_comment','text',true)]),
 table('change_records',[...common,column('cycle_id','uuid'),column('item_id','uuid',true),column('type','text'),column('payload','jsonb'),column('status','text'),column('requested_by','uuid'),column('reviewed_by','uuid',true),column('countersigned_by','uuid',true)]),
 table('recurring_templates',[column('organization_id','uuid'),column('category_id','uuid'),column('content','text'),column('quality_standard','text'),column('assignees','jsonb'),column('lead_person_id','uuid'),column('escalated','boolean'),column('remark','text',true),column('enabled','boolean'),column('sort','integer'),column('revision','integer')]),
 table('supervision_entries',[...common,column('cycle_id','uuid'),column('meeting_date','date'),column('meeting_title','text'),column('raw_text','text'),column('item_id','uuid',true),column('registered_by','uuid')]),
 table('language_patterns',[column('organization_id','uuid'),column('category_id','uuid'),column('content_pattern','text'),column('quality_pattern','text'),column('example','text',true),column('enabled','boolean'),column('created_by','uuid'),column('created_at','timestamptz'),column('updated_at','timestamptz')]),
 table('review_bindings',[column('organization_id','uuid'),column('category_id','uuid'),column('person_id','uuid'),column('created_at','timestamptz')]),
 table('audit_events',[...common,column('entity_type','text'),column('entity_id','uuid'),column('action','text'),column('actor_id','uuid'),column('request_id','uuid'),column('before','jsonb',true),column('after','jsonb',true)]),
 index('plan_cycles','cycles_org_month_unique',['organization_id','year','month'],true),
 index('category_nodes','categories_org_parent_idx',['organization_id','parent_id','sort']),
 index('plan_items','items_org_cycle_status_idx',['organization_id','cycle_id','status']),
 index('plan_items','items_org_category_idx',['organization_id','category_id']),
 index('plan_item_assignees','assignees_item_person_unique',['item_id','person_id'],true),
 index('review_bindings','bindings_org_category_person_unique',['organization_id','category_id','person_id'],true),
 index('audit_events','audit_org_entity_idx',['organization_id','entity_type','entity_id'])
]};

export const confirmationMigration={migrationVersion:'1.0',operations:[
 {kind:'addColumn',table:'plan_cycles',column:column('confirmed_by','uuid',true)},
 {kind:'addColumn',table:'plan_cycles',column:column('confirmed_at','timestamptz',true)},
 {kind:'addColumn',table:'plan_items',column:column('via_change','boolean',true)}
]};
