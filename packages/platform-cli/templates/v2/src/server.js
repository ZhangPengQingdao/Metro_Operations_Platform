import {AppServerError,defineServer} from '@metro/platform-sdk/server';

const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export default defineServer({
  // 接口名与 app.json 的 api[].id 一致；平台已校验接口权限，这里再按数据范围过滤。
  async list(_input, ctx) {
    const grant = ctx.employee.businessAuthorization?.grants.find(item => item.permission === `app.${ctx.appId}.read`);
    if (!grant) throw new AppServerError('ACCESS_DENIED');
    const anyOf = [];
    if (grant.self) anyOf.push([{column: 'created_by', value: ctx.employee.personId}]);
    if (grant.organizationIds.length) anyOf.push([{column: 'organization_id', in: grant.organizationIds}]);
    if (!grant.all && !anyOf.length) return {rows: []};
    const {rows} = await ctx.data.list('records', {
      ...(grant.all ? {} : {anyOf}), order: {column: 'created_at', direction: 'desc'}, pageSize: 50,
    });
    return {rows};
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
