# 共享查询列表

平台和独立应用统一使用 L2 `DataList`，不在页面重新定义工具栏间距、表格行高或操作按钮外观。独立应用从 `@metro/platform-sdk/ui` 引入同一实现。

```tsx
<DataList
  toolbar={<FilterBar showDateRange={false} searchValue={search} onSearchChange={setSearch}
    rightAction={<Button onClick={openCreate}>新增</Button>} />}
  emptyState={rows.length === 0 ? '暂无记录' : undefined}
  pagination={<ListPagination page={page} total={total} hasNext={hasNext}
    onPrevious={previous} onNext={next} />}>
  <thead><tr><th>名称</th><th>操作</th></tr></thead>
  <tbody>{rows.map(row => <tr key={row.id}>
    <td>{row.name}</td>
    <td><TableActions><TableActionButton icon={<PencilSimpleLine size={18}/>}
      disabled={!row.canEdit} onClick={() => edit(row)}>修改</TableActionButton></TableActions></td>
  </tr>)}</tbody>
</DataList>
```

- `toolbar` 放现有搜索、筛选、新增控件；没有相应功能就不传，不增加虚假的搜索或筛选。
- `notice` 为可选状态内容；`pagination` 支持分页组件或特定已有翻页操作。
- 操作列始终是最后一列，默认固定右侧；没有操作列时传 `pinActions={false}`（如审计列表）。
- `TableActions` 统一行内间距；`TableActionButton` 使用 SVG 图标和底部文字，继承禁用、点击及可访问属性。
- `ListPagination` 同时支持页码/总数和游标分页，无总数时省略 total。
- 窄屏表格横向滚动，避免姓名和编码被压成逐字换行；操作列仍可访问。需要换行的长描述由具体单元格明确设置。
- 查询、权限检查、写入确认和失败恢复仍归调用页面。组件只统一布局，不替页面开放权限或重放请求。
