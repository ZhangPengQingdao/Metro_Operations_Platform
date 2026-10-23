import {defineServer} from '@metro/platform-sdk/server';

const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export default defineServer({
  // 接口名与 app.json 的 api[].id 一致；平台已校验接口权限，这里再按数据范围过滤。
  async list(_input, ctx) {
    const {rows} = await ctx.data.list('records', {order: {column: 'created_at', direction: 'desc'}, pageSize: 50});
    return {rows: rows.filter(row => ctx.can('read', {organizationUnitId: row.organization_id, ownerPersonId: row.created_by}))};
  },

  async create(input, ctx) {
    const title = typeof input?.title === 'string' ? input.title.trim() : '';
    if (!isUuid(input?.requestId) || !title || title.length > 100) throw new Error('INVALID_INPUT');
    const organizationUnitId = ctx.employee.organizationUnitId;
    ctx.require('create', {organizationUnitId, ownerPersonId: ctx.employee.personId});
    // A retry with the same requestId writes nothing and returns the first result, so read the id from it.
    const {results} = await ctx.data.transaction(input.requestId, [{action: 'insert', table: 'records', id: ctx.uuid(), values: {
      title, organization_id: organizationUnitId, created_by: ctx.employee.personId, created_at: new Date().toISOString(),
    }}]);
    return {id: results[0].row.id};
  },
});
