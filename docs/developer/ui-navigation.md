# 界面组件与标准导航

## 页面责任

平台提供页头、侧边栏、主题和应用容器。应用输出内容页。优先使用 @metro/platform-sdk/ui 的 QueryList、FilterBar、DataList、Table、ListPagination、Dialog、SidebarDialog、OrganizationPicker、OrganizationPeoplePicker 等共享组件。

React / React DOM 19 是 UI 包的可选 peer；无界面的后端应用无需安装。组件只处理显示和交互，人员查询、权限校验与分页请求由应用实现。

```jsx
import {QueryList,TableHeader,TableBody,TableRow,TableHead,TableCell} from '@metro/platform-sdk/ui';
<QueryList pinActions={false}
  query={{showDateRange:false,searchValue:search,onSearchChange:setSearch,searchPlaceholder:'搜索姓名'}}
  emptyState={rows.length ? undefined : '暂无数据'}>
  <TableHeader><TableRow><TableHead>姓名</TableHead><TableHead>工号</TableHead></TableRow></TableHeader>
  <TableBody>{rows.map(row => <TableRow key={row.id}><TableCell>{row.name}</TableCell><TableCell>{row.employeeNo}</TableCell></TableRow>)}</TableBody>
</QueryList>
```

普通下拉选 DropdownSelect，可搜索选择用 SearchSelect，多人选择用 TagDropdownPicker，日期时间用 DatePicker / TimePicker。行操作用 TableActions / TableActionButton。只展示已实现的筛选与功能。

## 样式与沙箱

标准示例演示从 document.currentScript 获取宿主提供的 data-platform-origin 和 nonce，用 platformUiCss 安装共享样式。脚本入口需打包成可自行执行的浏览器 IIFE，不依赖 CDN。遵守 CSP；页面背景透明，使用 --afc-color-canvas、--afc-color-paper、--afc-color-ink 等主题变量。

标准沙箱没有 allow-forms。保存用普通按钮 onClick，不依赖原生表单提交。导出需在签名清单 ui 中声明 downloads:true，再使用 app-files 的下载函数。打开/关闭弹窗用 sandbox.invoke('platform.ui.modal',{open}) 通知宿主。

## 侧边栏声明

```json
{
  "routes": [{"id":"home","path":"/","permission":"app.inventory.read"},{"id":"settings","path":"/settings","permission":"app.inventory.manage"}],
  "navigation": [{"id":"home","label":"库存","routeId":"home","order":0},{"id":"settings","label":"设置","routeId":"settings","order":1}],
  "ui": {"mode":"sandbox","entryArtifactId":"frontend","clientRouting":true}
}
```

安装后宿主按 navigation 生成标准侧栏，并按 route.permission 过滤和检查访问。应用读取初始 data-app-route，并用 sandbox.onRouteChange 更新内容。platform.ui.navigation 只能收窄已声明、已授权入口；不能提升权限。不要自己绘制另一套平台侧栏，也不要在应用内注入重复的负责人管理入口。

## 图标

最终安装清单使用 icon.paths：24×24 视口下的 SVG path 字符串数组，最多16条、每条≤2048字符。可在源码中存 icon.json，由构建脚本写入 manifest.icon；文件名本身不决定宿主图标。不接受外链图片、完整SVG HTML或脚本。未提供时宿主显示通用图标。

## 界面验收

检查真实标准沙箱内的查询、保存与失败反馈；导航切换和直接访问；明暗主题；390px窄屏；弹窗关闭；有权限和无权限状态；大列表分页。演示截图不能替代实际点击验收。
