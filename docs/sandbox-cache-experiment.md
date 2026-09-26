# 员工沙箱 frontend JS 缓存实验（2026-09-23）

## 背景与结论

基于 `main` 的 `b5afd16`，员工应用首次创建 iframe 时，`/ui` 读取并校验已安装 frontend artifact，随后把整个 JS 内联到一次性 `/document/<token>`。document 为 `no-store`，短期有效且只能消费一次；加载时再次验证准入。工作台已有最多两个 retained iframe 和约 300 ms 的最近应用预热。

曾试验把内联 JS 拆成 `/assets/<appId>/<artifact.sha256>/ui.js`，对 asset 返回 `Cache-Control: public, max-age=31536000, immutable`，并保持独立资源域、`sandbox="allow-scripts"`、opaque origin、nonce CSP、一次性 document 和原有 SandboxBridge。**Chrome 153 中新建的 opaque iframe 没有复用前一个 iframe 的该 JS HTTP cache；总传输量与 iframe load 耗时没有改善，因此已撤回此实现。** 当前仓库的加载链路和安全模型保持原状，retained/prewarm 仍是主要的热启动手段。

## 复现方法与数据

在本机 HTTPS 资源域和平台域下，用同一段约 250 KB 的经典 JS 比较内联 document 与 hash URL 外部脚本。每次销毁旧 iframe，创建新的 `sandbox="allow-scripts"` iframe；每组连续加载 5 次，交替运行两轮，记录资源服务器 HTTP 响应体字节、请求数和 iframe `load` 耗时。测试脚本没有业务 API 或数据库，结果只说明资源加载行为，不代表生产端到端耗时。使用同一浏览器上下文，未启用请求拦截或 DevTools 禁用缓存。

| 方案 | 5 次 document 传输 | 5 次 JS asset 传输 | 合计 | 预热后的 iframe load |
| --- | ---: | ---: | ---: | --- |
| 内联 JS | 1,256,450 B | 0 B | 1,256,450 B | 约 7 ms |
| 拆分 JS | 7,065 B | 1,250,275 B | 1,257,340 B | 约 7–8 ms |

首轮样本：内联 `[24, 8, 7, 7, 7]` ms；拆分 `[10, 8, 8, 8, 8]` ms。第二轮两组均为 `[7, 7, 7, 7, 7]` ms。首样本受本机连接和浏览器预热影响，不宜据此推断生产性能。拆分使 document 缩小，但总字节略增，每次打开还多一个 asset 请求。另用同一普通页面连续请求同一 hash asset，浏览器只向服务器请求一次；这与新建 opaque iframe 的表现不同。现有 retained iframe 返回时没有重新导航或请求 document/asset，工作台预热后进入也复用已加载 iframe。

Chrome 的 [HTTP cache 分区说明](https://developer.chrome.com/blog/http-cache-partitioning/)和 [NetworkIsolationKey 实现说明](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/base/network_isolation_key.h)与这一现象相符：缓存不仅按 URL 区分，还受 frame 的隔离上下文影响。实验结果证明了此浏览器和场景的未命中；其他浏览器或真实部署需分别验证。

## 后续实验边界

单独评估“稳定独立 App Origin + `allow-same-origin`”是否能在每个 App 之间保持隔离并获得缓存复用。该方向会改变现有安全边界，应先做威胁分析和跨 App、Cookie、存储、Bridge、CSP 的验证，再决定是否实施。本次没有启用它，也没有加入宿主传递 bundle 的协议。
