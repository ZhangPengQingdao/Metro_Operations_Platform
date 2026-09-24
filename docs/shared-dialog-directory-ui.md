# L2 弹窗与组织选择

平台与独立应用共用 `@metro/platform-sdk/ui` 组件及 `@metro/platform-sdk/ui-styles` 样式。普通确认或表单使用 `Dialog`；需要左侧分区导航、右侧独立滚动内容时使用 `SidebarDialog`，不在业务页面复制侧栏结构和滚动 CSS。

```tsx
<SidebarDialog open title="应用设置" onClose={close}
  sections={[{id:'general',label:'基本信息'},{id:'access',label:'使用权限'}]}
  activeSection={section} onSectionChange={setSection}>
  {section === 'general' ? <GeneralSettings/> : <AccessSettings/>}
</SidebarDialog>
```

组织单选用 `OrganizationPicker`：传入 ID、名称、父 ID 和可选状态，控件显示完整层级路径；`excludeId` 排除自身及下级。组织与人员联选用 `OrganizationPeoplePicker`：左侧组织树、右侧成员查询与分页，支持本页勾选、组织勾选及调用方渲染成员操作。两者均由调用方提供数据并持有选中状态；组件不读取目录接口、不判断业务权限。

```tsx
<OrganizationPeoplePicker organizations={organizations} people={people}
  organizationId={organizationId} onOrganizationChange={setOrganizationId}
  search={search} onSearchChange={setSearch} page={page} hasNext={hasNext}
  onPageChange={setPage} selected={person => selectedIds.includes(person.id)}
  onPersonChange={(person,checked) => updateSelected(person.id,checked)}/>
```

弹窗或选择器内的保存、取消、失败处理、员工与业务授权仍由页面和现有 Gateway 负责。
