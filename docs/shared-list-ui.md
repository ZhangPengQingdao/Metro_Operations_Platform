# 共享查询列表

平台和独立应用统一使用 L2 `DataList`，不在页面重新定义工具栏间距、表格行高或操作按钮外观。有查询工具栏的列表使用 `QueryList`，它组合 `FilterBar` 与 `DataList`。独立应用从 `@metro/platform-sdk/ui` 引入同一实现。

```tsx
<QueryList
  query={{showDateRange: false, searchValue: search, onSearchChange: setSearch}}
  actions={<Button onClick={openCreate}>新增</Button>}
  emptyState={rows.length === 0 ? '暂无记录' : undefined}
  pagination={<ListPagination page={page} total={total} hasNext={hasNext}
    onPrevious={previous} onNext={next} />}>
  <thead><tr><th>名称</th><th>操作</th></tr></thead>
  <tbody>{rows.map(row => <tr key={row.id}>
    <td>{row.name}</td>
    <td><TableActions><TableActionButton icon={<PencilSimpleLine size={18}/>}
      disabled={!row.canEdit} onClick={() => edit(row)}>修改</TableActionButton></TableActions></td>
  </tr>)}</tbody>
</QueryList>
```

- `QueryList` 的 `query` 接受 `FilterBar` 参数；`actions` 放新增等操作。纯表格仍用 `DataList` 的可选 `toolbar`。
- 默认 `compact` 布局的搜索收起，搜索、筛选、功能菜单与新增操作同排；`spread` 显式启用常驻搜索。月份等条件放入 `filterGroups`，必选上下文使用 `isMulti: false` 和 `allowAll: false`，重置时由页面保留必选上下文。
- 非选项式条件可用 `FilterGroup.renderOptions(selected, onChange)` 渲染共享控件（如月份输入）；`onChange` 仅更新筛选草稿，仍由统一确定/取消控制生效，页面在 `onApplyFilters` 校验实际值。
- 筛选与功能菜单复用 `FloatingPortal`，限制在当前文档视口内；筛选正文独立滚动，底部确认和重置始终可见。取消后再次打开恢复已生效条件。日期等嵌套浮层挂在最近的弹窗或浮层下，选择日期不会被外层误判为点击外部。
- 表单 `DropdownSelect` 的触发器、选项与弹层使用共享主题变量，支持宿主的即时浅色/暗色切换。
- `notice` 为可选状态内容；`pagination` 支持分页组件或特定已有翻页操作。
- 操作列始终是最后一列，默认固定右侧；没有操作列时传 `pinActions={false}`（如审计列表）。
- `TableActions` 统一行内间距；`TableActionButton` 使用 SVG 图标和底部文字，继承禁用、点击及可访问属性。
- `ListPagination` 同时支持页码/总数和游标分页，无总数时省略 total。
- 窄屏表格横向滚动，避免姓名和编码被压成逐字换行；操作列仍可访问。需要换行的长描述由具体单元格明确设置。
- 查询、权限检查、写入确认和失败恢复仍归调用页面。组件只统一布局，不替页面开放权限或重放请求。
