# L2 弹窗与组织选择

平台与独立应用共用 `@metro/platform-sdk/ui` 组件，样式由平台宿主提供。普通确认或表单使用 `Dialog`；需要左侧分区导航、右侧独立滚动内容时使用 `SidebarDialog`，不在业务页面复制侧栏结构和滚动 CSS。

普通弹窗的标题、内容和按钮区使用同一底色，不加外框或上下分隔线。有侧栏的弹窗保留左右两种底色，每一侧从顶到底一致；标题和按钮区不另铺底色。内容中的表单边框、状态提示和选中状态保留。侧栏切换、页签和分页等导航使用圆角矩形（`Button shape="rounded"`），保存、取消、确认等操作按钮使用默认胶囊形。

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
