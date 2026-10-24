# 界面组件与标准导航

## 页面责任

页面直接渲染在平台内容区（同源，不是 iframe）。平台提供页头、页面标题、侧栏、主题、提示和确认框；应用只写内容。

```jsx
import {useState, useEffect} from 'react';
import {defineApp, useApp} from '@metro/platform-sdk/app';
import {QueryList, TableHeader, TableBody, TableRow, TableHead, TableCell} from '@metro/platform-sdk/ui';
import './ui.css';

function Records() {
  const {api, user, navigate, toast} = useApp();
  const [rows, setRows] = useState([]);
  useEffect(() => { void api.call('list', {}).then(reply => { if (reply.ok) setRows(reply.result.rows); }); }, []);
  return <QueryList query={{showDateRange: false}} emptyState={rows.length ? undefined : '暂无数据'}>
    <TableHeader><TableRow><TableHead>名称</TableHead></TableRow></TableHeader>
    <TableBody>{rows.map(row => <TableRow key={row.id} onClick={() => navigate(`/records/${row.id}`)}><TableCell>{row.name}</TableCell></TableRow>)}</TableBody>
  </QueryList>;
}
function Detail({params}) { /* params.id */ }
export default defineApp({pages: {'/': Records, '/records/:id': Detail}});
```

优先使用 `@metro/platform-sdk/ui` 的共享组件：QueryList、FilterBar、DataList、Table、ListPagination、Dialog、SidebarDialog、DropdownSelect、SearchSelect、TagDropdownPicker、DatePicker / TimePicker、OrganizationPicker、OrganizationPeoplePicker、TableActions / TableActionButton。只展示已实现的筛选与功能。

## 页面与侧栏

页面在 `app.json` 的 `pages` 中声明：`{path, title, permission, nav}`。平台按数组顺序生成侧栏（`nav: true` 的页面），用 `title` 作页面标题，并按 `permission` 检查访问；页面里不要再画大标题或侧栏。带参数的页面（`/records/:id`）不进侧栏，通过 `navigate()` 或通知链接打开，参数在组件的 `params` 和 `useApp().route.params` 中。

## 样式

样式写在 `src/ui.css` 并在 `ui.jsx` 中 `import './ui.css'`；构建时自动限定到本应用（`[data-app="<id>"]`），不会影响平台或其他应用。颜色、字号使用平台 CSS 变量（如 `var(--afc-color-muted)`），以跟随明暗主题。暂不支持 `@keyframes`、`@font-face`、`@import`。

## 图标

项目根目录的 `icon.svg`（或 `icon.png`）就是应用图标：白色线条，显示在 `app.json` 的 `color` 底色上。不接受外链图片。

## 界面验收

在平台内实际点击：查询、保存与失败反馈；侧栏切换和直接访问页面；明暗主题；弹窗关闭；有权限和无权限状态；大列表分页。截图不能替代实际操作验收。
