# 慧策通·计划督办应用 详细实现规划书

- 版本：v2.0（实现规格，基于 8 条已决议题）
- 日期：2026-09-21
- 前置文档：本文件 v0.1 业务规划稿（已并入并取代）
- 依据材料：《大计划管理"金点子"创新大赛参赛报名表》（AFC 维保部）、《运营一中心 AFC 维保部 9 月份工作计划》（实表 33 条）
- 读者：应用开发、平台侧排期、业务对口人、管理端审批人

---

## 0. 决议记录

| # | 议题 | 决议 | 状态 |
| --- | --- | --- | --- |
| D1 | 中心/公司层级 | 最终接入同一应用；P0/P1 按部门实例运行，用 escalated 标记+筛选导出上报；P2 中心级聚合 | 已定（中心接入时间点待业务排期） |
| D2 | 语言库归属 | 初始由管理岗从历史计划整理；归口岗维护所辖分类句式，管理岗全量维护；P1 先行、不依赖 AI 网关 | 已定 |
| D3 | 纪要载体 | 双轨假设：文本纪要粘贴提取（P1）；录音转写（P2）走同一 `raw_text` 入口，不阻塞排期 | 已定 |
| D4 | 锁定后补报 | 允许，走变更流程：管理岗发起→归口复审→生效；仅 escalated 条目需负责人追认（应用内确认+审计） | 已定 |
| D5 | 检修计划边界 | 属另一套作业级专项计划，不建模；月度计划只含"编制检修计划"条目，成品作附件交账 | 已定 |
| D6 | 完成确认 | 归口单确认为主；管理岗保留事后驳回权（留痕）；逾期/延期由管理岗处理 | 已定 |
| D7 | 导出模板 | 按 9 月实表 1:1 做 v1（含纵向合并单元格），标题前缀可配置；M4 拿导出件走一次真实上报后定稿 | 已定（模板正式认可待中心反馈） |
| D8 | 命名 | appId=`huicetong`；员工端显示名"慧策通·计划督办"；对外参赛用申报书原名 | 已定 |

---

## 1. 应用定位与边界

**定位**：部门月度工作计划的"编制—审核—汇总—签发—执行—交账"全流程在线化，替代现行"收零散条目→人工拼表→线下上报→催材料"过程。

**在范围**：月度工作计划条目、归口审核、督办直插、完成提报与证明材料、汇总导出、固定项模板、标准语言库（P1）。

**不在范围**（D5）：检修计划等作业级专项计划的内容管理（仅作为条目附件）；中心/公司本级计划编制（P2）；考勤、绩效等被引用的业务域。

**形态**（平台签名应用，参照物料应用已验证链路）：

```
appId:      huicetong
ui:         sandbox        # L2 共享组件（FilterBar/Table/Dialog 等）
backend:    isolated       # 平台审批固定 Node 镜像，非 root、只读 FS、8080 健康端点
storage:    managed        # 应用自管表 + 追加式迁移
能力声明:    notifications / signatures / attachments / business-audit / people(read) / app_data(服务身份)
```

**架构原则**

1. 计划域数据全部落应用自管表（周期锁、分类树、多责任人、归口审核等域逻辑自持，不依赖 work-items 语义）。
2. 平台能力只做公共件：通知、签字、附件、审计、人员。
3. 出应用的动作（导出、AI、录音）全部经平台受控通道，应用不自行外联。
4. AI 永远是"建议者"：本人确认+归口复核不省略（与申报书一致）。
5. 导出格式与现行 Excel 完全兼容（D7），上报链路不变。

---

## 2. 角色与权限

### 2.1 业务角色

| 角色 | 职责 | 数据范围 |
| --- | --- | --- |
| 填报人 | 填报本人条目、牵头人提报完成 | 本人条目 |
| 归口审核岗 | 审核所辖分类条目、确认完成、驳回、维护该分类语言库（P1） | 所辖分类（level2 绑定） |
| 计划管理岗 | 周期管理、汇总、锁定、督办登记、变更发起、字典/归口/模板维护、导出、导入 | 本部门全部 |
| 部门负责人 | 签发、escalated 变更追认、全景查看 | 本部门全部（只读+签发/追认） |
| 中心查看（P2） | 查看上卷计划 | 授权范围（待平台跨组织授权模型） |

说明：填报人/归口岗/管理岗可由同一人兼任；管理岗在应用内"设置"指定（参照物料应用物资管理员模式，不改变平台员工角色）。

### 2.2 平台权限码（manifest 逐接口声明）

| 权限码 | 授予对象 | 覆盖接口 |
| --- | --- | --- |
| `app.huicetong.read` | 全部使用角色 | 周期/条目/看板/导出/导入预览查询类 |
| `app.huicetong.fill` | 填报人 | 条目增改、提交、完成提报（限本人/牵头） |
| `app.huicetong.review` | 归口审核岗 | 审核、完成确认/驳回、变更复审、变更追认（限所辖分类） |
| `app.huicetong.manage` | 计划管理岗 | 周期流转、督办登记、变更发起、字典/归口/模板/导入/导出 |

服务身份另授 `platform.app_data.read/write/transaction`（托管存储）与 `platform.people.read`（范围=本部门，用于责任人与组织解析）。

### 2.3 权限矩阵（读接口均需 `read`，下表列写操作）

| 操作 | fill | review | manage | 负责人 | 数据守卫 |
| --- | --- | --- | --- | --- | --- |
| 条目创建/修改（未锁定） | 本人 draft/returned | — | 全部 | — | 组织校验；版本原子写 |
| 条目提交 | 本人 | — | — | — | 状态 draft/returned |
| 条目审核（通过/退回） | — | 所辖分类 | — | — | 周期∈reviewing |
| 完成提报 | 牵头人 | — | — | — | 周期∈locked/closing |
| 完成确认/驳回 | — | 所辖分类 | — | — | 存在 pending 提报 |
| 完成驳回兜底 | — | — | ✓（事后驳回） | — | 已确认 7 日内 |
| 审核变更申请 | — | 所辖分类 | — | — | 周期∈locked |
| escalated 变更追认 | — | — | — | ✓ | 变更已归口通过 |
| 周期全流程操作 | — | — | ✓ | — | 状态机守卫 |
| 签发 | — | — | — | ✓（经平台签字） | 周期∈countersigning |
| 督办登记 | — | — | ✓ | — | 周期任意未归档态 |

### 2.4 归口绑定

`review_bindings`：分类（level2，共 6 个）→ 归口人（可多人）。管理岗维护；创建周期时页面强制提示复核；一个分类无绑定人时该分类条目不可进入审核（提交时给出明确提示）。

---

## 3. 数据模型（托管存储）

> 约束：迁移只允许追加、新增列仅可空，不能回退。P0 建表一次到位，可能扩展的字段以可空列预留。

| 表 | 字段（类型/约束） | 说明 |
| --- | --- | --- |
| `plan_cycles` | id PK · org_unit_id · year · month · status · fill_deadline 可空 · created_by · created_at · updated_at | 月度周期；UNIQUE(org_unit_id, year, month)；status 见 §4.1 |
| `category_nodes` | id PK · parent_id 可空 · level(1|2|3) · name · sort · enabled · created_at | 三级分类树；预置数据见附录 A |
| `plan_items` | id PK · cycle_id FK · category_id FK(level3) · content · quality_standard · start_date · end_date · status · source(manual/supervision/recurring) · supervision_entry_id 可空 · escalated BOOL · remark 可空 · lead_person_id · created_by · version · created_at · updated_at | 计划条目；INDEX(cycle_id,status)、INDEX(category_id)；overdue 为派生值不落库（end_date<今日 且 status=in_progress） |
| `plan_item_assignees` | id PK · item_id FK · person_id · is_lead BOOL · sort | 多责任人；UNIQUE(item_id,person_id)；is_lead=真 的 person_id 冗余存条目 lead_person_id |
| `review_records` | id PK · item_id FK · cycle_id · reviewer_id · action(approve/return) · comment 可空 · created_at | 审核留痕 |
| `completion_records` | id PK · item_id FK · summary · status(pending/confirmed/rejected) · submitted_by · submitted_at · confirmed_by 可空 · confirmed_at 可空 · reject_comment 可空 | 完成提报；证明材料经平台 attachments 挂 entity(type=`plan_item`, id=itemId)，不在本表存 ID |
| `change_records` | id PK · cycle_id · item_id 可空(新增时为空) · type(add/update/cancel/extend) · payload JSON · status(pending/approved/rejected/countersigned) · requested_by · reviewed_by 可空 · countersigned_by 可空 · created_at | 锁定后变更（D4）；escalated 变更 approved 后需负责人追认 → countersigned |
| `recurring_templates` | id PK · org_unit_id · category_id · content · quality_standard · assignees JSON · lead_person_id · escalated BOOL · remark 可空 · enabled BOOL · sort | 固定项模板；建周期/复制上月时自动实例化 |
| `supervision_entries` | id PK · cycle_id · meeting_date · meeting_title · raw_text · item_id 可空 · registered_by · created_at | 督办来源登记；raw_text 为 P1 文本提取/P2 转写的统一入口（D3） |
| `language_patterns` | id PK · category_id(level2) · content_pattern · quality_pattern · example 可空 · enabled · created_by · updated_at | 标准语言库（P1，D2）；P0 预建表不启用功能 |
| `review_bindings` | id PK · category_id(level2) · person_id · created_at | 归口配置；UNIQUE(category_id, person_id) |

**附件与导出文件**：证明材料、导出 xlsx 统一登记平台 attachments（sourceEntityType 区分 `plan_item` / `cycle_export`），下载用平台一次性地址（60 秒）。

**签字**：周期签发用平台 signatures，entityId=cycleId，title=`{部门}N月份工作计划签发`，signer=部门负责人。

---

## 4. 状态机

### 4.1 周期

```
drafting ──submit-review──▶ reviewing ──submit-countersign──▶ countersigning
   ▲                           │                                   │
   └──────return-draft─────────┘                                   ├──sign(签字完成)──▶ locked
                （管理岗可整体退回）                                   └──拒签/撤回──────▶ reviewing
locked ──begin-closing──▶ closing ──archive──▶ archived
```

| 迁移 | 触发者 | 守卫 | 副作用 |
| --- | --- | --- | --- |
| 创建（含复制上月） | manage | 同月唯一 | 复制归档周期条目→draft；固定项模板实例化（日期顺延至新月窗）；通知填报人 |
| submit-review | manage | drafting | 无归口绑定的分类存在时拒绝并列出 |
| return-draft | manage | reviewing | 通知被退条目填报人 |
| submit-countersign | manage | reviewing 且无 pending 退回条目 | 创建平台签字请求，通知负责人 |
| sign→locked | 负责人签字 + manage.lock | 签字请求 completed（服务端核验） | 全部 approved→in_progress；通知全员"已锁定" |
| begin-closing | manage | locked | 生成逾期清单摘要通知管理岗与各逾期牵头人 |
| archive | manage | closing 且条目全部 ∈{completed,cancelled} | 周期只读，可被后续复制 |

### 4.2 条目

```
draft ──submit──▶ submitted ──approve──▶ approved ──(周期locked)──▶ in_progress
  ▲                  │                                            │
  └────return────────┘                                            ├──completion.submit──▶ pending_confirm
 （退回后改后重报）                                                    │                        │
                                                                      │      confirm──▶ completed
                                                                      └──reject──▶ in_progress
任意态 ──cancel──▶ cancelled（锁定前：本人/manage；锁定后：变更流程）
```

- `returned` 不单独设状态：退回即回到 `draft` 并写入 review_records，前端按最近退回记录提示。
- 完成确认/驳回见 D6：归口确认关闭；管理岗对已确认条目 7 日内可驳回重报（留痕）。
- 延期（extend）：in_progress 且逾期时，牵头人发起延期申请（新 end_date+理由）→ 归口批准 → end_date 更新，原逾期区间在审计中保留。

### 4.3 变更（locked 周期，D4）

```
管理岗发起(add/update/cancel/extend) → pending
  → 归口复审：approve → escalated? → 负责人追认 → countersigned → 生效写回条目
                        └非 escalated → 直接生效写回条目
              reject → rejected（留痕，不改条目）
```

生效即对 plan_items 做对应写（新增条目 source=manual，标记 `via_change`）；escalated 变更追认为应用内动作+审计（频次低，不占用平台签字）。

---

## 5. API 规格

沙箱经 `createAppApiClient(sandbox).invoke(apiId, payload)` 调用；接口 ID、方法/路径、权限码逐条在 manifest 声明；后端 handler 第三参获取可信员工上下文（personId、orgUnitId、权限），所有写接口服务端复核范围。

### 5.1 周期

| 接口 ID | 权限 | 入参要点 | 校验/副作用 |
| --- | --- | --- | --- |
| `cycle.create` | manage | year, month, copyFromCycleId? | 同月唯一；复制/固定项实例化；事务内完成 |
| `cycle.list` / `cycle.get` | read | — | 按调用者组织过滤 |
| `cycle.submit-review` | manage | cycleId | §4.1 守卫 |
| `cycle.return-draft` | manage | cycleId | 通知 |
| `cycle.submit-countersign` | manage | cycleId | 创建签字请求 |
| `cycle.signature-status` | read | cycleId | 代理 signatures.get |
| `cycle.lock` | manage | cycleId | 服务端核验签字完成 |
| `cycle.begin-closing` / `cycle.archive` | manage | cycleId | §4.1 守卫；archive 生成逾期结转提示 |

### 5.2 字典与配置

| 接口 ID | 权限 | 说明 |
| --- | --- | --- |
| `category.tree` / `category.upsert` | read / manage | 三级树；禁用不改历史条目 |
| `binding.list` / `binding.upsert` / `binding.delete` | read / manage | 归口绑定 |
| `recurring.list` / `recurring.upsert` / `recurring.delete` | read / manage | 固定项模板 |
| `language.list` / `language.upsert`（P1） | read / review(所辖)+manage | 语言库 |

### 5.3 条目

| 接口 ID | 权限 | 入参要点 | 校验/副作用 |
| --- | --- | --- | --- |
| `item.create` | fill+manage | cycleId, categoryId, content, qualityStandard, startDate, endDate, assignees[{personId,isLead}], escalated, remark? | 周期∈drafting；责任人属本组织；≥1 lead |
| `item.update` | fill(本人 draft)+manage | itemId, …, expectedVersion | 原子写旧值校验 |
| `item.submit` | fill(本人) | itemId, expectedVersion | 状态守卫；无归口绑定分类时明确报错 |
| `item.review` | review | itemId, action, comment? | 周期∈reviewing；分类∈绑定；写 review_records |
| `item.list` | read | cycleId?, status?, categoryId?, personId?, cursor | 组织过滤；游标分页 |
| `item.get` | read | itemId | 组织过滤 |
| `item.cancel` | fill(本人,锁定前)/manage | itemId, reason | 锁定后走 change |
| `completion.submit` | fill(牵头人) | itemId, summary, 附件经 entity 上传 | 周期∈locked/closing |
| `completion.confirm` / `completion.reject` | review | itemId, comment? | pending 提报存在 |
| `completion.overturn`（兜底驳回） | manage | itemId, comment | 已确认 ≤7 日 |

### 5.4 变更 / 督办 / 看板 / 导出 / 导入

| 接口 ID | 权限 | 说明 |
| --- | --- | --- |
| `change.create` | manage | type+payload；escalated 条目标记需追认 |
| `change.review` | review | 所辖分类 |
| `change.countersign` | 负责人 | escalated 变更 |
| `change.list` | read | 按周期 |
| `supervision.register` | manage | 登记+生成 source=supervision 条目直入 submitted；周期≥reviewing 时经该分类归口复审后插入 |
| `supervision.list` | read | 按周期 |
| `board.stats` | read | cycleId → 状态计数/分类分布/牵头人负载 TopN/逾期清单/督办完成率 |
| `export.plan` | read | cycleId, scope=all|escalated → 后端生成 xlsx→attachments→返回一次性地址；审计记录 |
| `import.preview` / `import.execute` | manage | 粘贴 TSV 解析、分类名匹配预览、确认导入（requestId 幂等） |

---

## 6. 业务流程细则

### 6.1 编制（P0 主线）

1. 管理岗创建周期（复制上月）：归档条目转 draft、固定项实例化、日期顺延。
2. 通知全员填报（含截止时间）；填报人在"我的填报"录入/编辑/提交。
3. 归口岗在所辖分类视图审核：通过/退回（必填意见）→ 记录留痕。
4. 管理岗汇总预览（同构 Excel 视图）确认 → 提交签发 → 负责人平台签字 → 锁定。
5. 锁定后条目转 in_progress，只读；变更走 §4.3。

### 6.2 完成提报与交账（D5/D6）

1. closing 开启（或锁定期间随时）：牵头人提交完成说明+证明材料（attachments 挂条目）。
2. 归口确认 → completed；驳回 → in_progress 重报。
3. 逾期：派生标识，closing 开启时发摘要；牵头人可申请延期 → 归口批准改期（原区间审计保留）。
4. 无法完成：条目取消（说明原因留痕）。
5. archive：全部条目终态方可归档；逾期未决条目提示结转下期（复制为下期条目并关联原条目）。

### 6.3 督办直插

管理岗登记（会议日期/名称/事项/责任人/期限）→ source=supervision 条目 → 归口复审（周期未到 reviewing 则随常规流程）→ 生效插入 locked 周期 → 通知责任人确认 → 纳入统一提报与看板。P1 在此入口前增加"纪要粘贴→候选提取"；P2 增加录音转写（D3），提取产物仍走本流程。

### 6.4 语言库（P1，D2）

初始种子：管理岗用导入工具将历史计划（含 9 月 33 条）整理为句式条目；归口岗持续维护所辖分类。用途：填报联想（前端）+ AI 归一目标格式（P1 AI 上线后）。语言库功能不依赖 AI 网关，可先行交付。

---

## 7. 通知矩阵

| 事件 | 接收人 | 时机 |
| --- | --- | --- |
| 周期创建/开放填报 | 本部门全部填报授权人 | 事件触发 |
| 填报截止提醒 | 尚有 draft 条目者 | fill_deadline 当日（依赖平台调度，见 §14）；未就绪时降级为用户下次访问时检测补发+页内横幅 |
| 条目逾期当日提醒 | 牵头人、归口岗 | 依赖平台调度（§14）；未就绪时并入 closing 开启摘要+访问时检测 |
| 条目被退回 | 条目创建人 | 事件触发 |
| 签发请求 | 部门负责人 | 事件触发 |
| 周期锁定 | 全员 | 事件触发 |
| 督办条目插入生效 | 条目责任人 | 事件触发（含确认提醒） |
| closing 开启+逾期摘要 | 管理岗、各逾期牵头人 | 事件触发 |
| 完成被驳回 | 牵头人 | 事件触发 |
| escalated 变更待追认 | 部门负责人 | 事件触发 |

---

## 8. 审计事件

`business-audit` 逐条记录：周期创建/复制/各状态迁移/归档；条目创建/修改/提交/审核/取消；变更全链路（发起/复审/追认/生效）；完成提报/确认/驳回/兜底驳回/延期；督办登记；导出（含 scope）；导入执行；字典/归口/模板变更。审计查询以管理端为主，应用内提供业务级历史（review_records/completion_records/change_records）回溯界面。

---

## 9. 并发与一致性

| 场景 | 方案 |
| --- | --- |
| 条目并发编辑 | version 乐观锁，`app_data.transaction` 旧值校验，冲突返回明确错误码 |
| 周期状态迁移 | 事务内以旧 status 为条件写新 status，双写不一致即失败 |
| 锁定瞬间提交 | 周期状态校验与条目写入同事务 |
| 导入幂等 | 客户端生成 requestId，服务端去重 |
| 外部结果未知 | 签字状态/通知投递/导出文件生成结果未知时保留记录并阻断，不自动重放 |
| 组织隔离 | 每个 API 以可信员工上下文解析组织；所有读写按 org_unit_id 过滤/校验；责任人须属本组织（服务端经 people 校验） |

---

## 10. 界面规格（L2 组件）

| 视图 | 布局与要点 |
| --- | --- |
| 计划总览（默认页） | FilterBar（周期/模块/分类/状态/责任人/escalated）+ 层级表格（模块→分类可折叠，对齐 Excel 阅读习惯）；行操作随角色与周期状态出现（编辑/审核/提报完成）；`pinActions` 固定操作列；`layout="spread"` 放导出按钮 |
| 我的填报 | 分组：待提交（draft）/被退回/执行中/待提报完成/待确认督办；条目编辑用侧边栏 Dialog（`platform.ui.modal`），多责任人选择器按组织过滤，首位为牵头人 |
| 归口审核 | 仅渲染所辖分类；待审列表（条目+历史+变更）；通过/退回内联，退回必填意见；完成确认/驳回同视图 |
| 看板 | 数字卡片（总条目/已完成/进行中/逾期/督办）+ 分类分布表 + 牵头人负载表 + 逾期明细表；P0 纯表格不引图表 |
| 督办登记 | 登记表单 + 周期内督办台账（P1 前置加"粘贴纪要提取"入口） |
| 变更台账 | locked 周期变更列表：发起/复审/追认状态一目了然 |
| 设置 | 页签：周期管理 / 分类字典 / 固定项模板 / 归口配置 / 数据导入（粘贴 TSV）/（P1）语言库；按角色显隐 |

空态/错误态：无周期→引导创建；无归口绑定分类→提交时阻断并指明分类；版本冲突→提示刷新合并；导出生成中→禁用按钮+完成通知。

---

## 11. 导出规格（D7）

以 9 月实表为 v1 基线：

- 标题行合并 10 列：`{org名称}{N}月份工作计划`（前缀可配置）。
- 列序固定：`序号 | 模块 | 业务分类 | 业务模块 | 工作计划内容 | 完成质量标准 | 开始时间 | 完成时间 | 责任人 | 备注`。
- 模块列、业务分类列按分组纵向合并单元格；日期 `YYYY-MM-DD`；多责任人 `、` 连接；escalated 条目备注列前置"拟提报中心计划"（与历史格式一致），用户 remark 追加其后。
- scope=all 全量；scope=escalated 仅拟提报中心条目（D1 上报件）。
- 文件经 attachments 登记，一次性地址下载，审计记录导出人与范围。

---

## 12. 导入规格

- 入口：设置→数据导入；**粘贴 TSV**（从 Excel 直接复制），沙箱内不依赖本地文件读取。
- 解析列：模块/业务分类/业务模块/内容/质量标准/开始/完成/责任人（、分隔）/备注；分类按名称自动匹配，未命中标红人工指定。
- 目标二选一：当前 drafting 周期（转为 draft 条目）；或创建"历史参考"只读周期（archived）。
- 预览确认后执行，requestId 幂等，审计记录。

---

## 13. 分期与里程碑

### P0（应用 v1.0）

| 里程碑 | 内容 | 出口标准 |
| --- | --- | --- |
| M1 域模型与骨架 | 建表迁移、周期/字典/条目 CRUD、权限码与员工授权链路、组织隔离 | 演示环境可填报、越权被拒 |
| M2 编制闭环 | 归口审核、汇总视图、签发（signatures）、锁定、变更流程（§4.3）、导出 xlsx（§11） | 9 月实表 33 条端到端走通；导出与原表人工比对一致 |
| M3 执行闭环 | 完成提报+材料、督办登记、看板、通知矩阵、审计、固定项、粘贴导入 | 权限矩阵全项验证通过 |
| M4 试运行→v1.0 | 与真实月份双轨；导出件走一次真实上报（D7 验证）；采集基线 | 试运行部门验收 |

### P1（应用 v2.0）——语言库先行（D2），AI 为增强

1. 语言库管理与填报联想（无外部依赖，可早于本阶段启动）。
2. AI 草稿：大白话→结构化草稿（分类建议+规范内容+质量标准句式）→本人确认→常规流程。【前置：平台 `platform.llm.*` 网关，密钥不出平台、逐应用限流审计】
3. 纪要文本粘贴→候选事项提取→人工勾选→走督办直插。【同上前置】
4. 相似条目查重合并建议（可降级为文本相似度，不强依赖 AI）。

### P2（应用 v3.0）

1. 录音上传/受控录音→平台 ASR 转写→纪要流程。【前置：平台音频存储+转写能力】
2. 中心级聚合：中心周期=各部门 escalated 上卷+中心本级条目；跨组织查看。【前置：平台跨组织授权模型（D1）】
3. 半年/年度汇编：归档周期数据生成总结草稿（依赖 P1 AI）。
4. 督办系统对接（data-alignment / 应用外联放开后）。

---

## 14. 平台侧前置依赖（非应用内工作）

| 依赖 | 阻塞 | 现状 |
| --- | --- | --- |
| `platform.llm.*` AI 网关（OpenAI 兼容代理、密钥托管、审计限流） | P1-2/3 | `core/integrations/ai` 已有 OpenAI 兼容+tool calling 底座与管理端模型配置，缺应用侧代理能力 |
| 受控录音 + ASR 转写 | P2-1 | 沙箱禁麦克风，宿主录音未接通 |
| 跨组织数据范围授权模型 | P2-2 | 当前应用组织隔离为强约束，需新授权设计 |
| L2 签字交互组件确认 | M2 签发交互 | signatures API 已有（sign 带 image）；员工端签字板形态需确认，缺失则 M2 临时降级"应用内确认+审计"，P1 接签字板 |
| 平台调度循环 + manifest jobs 接通 | 截止/逾期提醒到点触达；应用内周期性动作 | manifest 已预留 jobs 声明位（`app-manifest.ts`：id/handler/intervalSeconds），安装前仍拒绝；work-items 已有 `generateDueRecurrences` 周期生成逻辑但服务端无循环驱动。单实例部署下平台进程内置轻量调度循环（定时调 recurrence 生成+按间隔调用应用声明 job）即可闭环，慧策通与待办类应用共同受益 |

---

## 15. 风险与对策

| 风险 | 对策 |
| --- | --- |
| AI 网关未建成拖累 P1 卖点 | 语言库先行可独立交付（D2）；AI 定位为增强；对外叙事区分"已实现/规划中" |
| 双轨期两套数据不同步 | 导出完全兼容（D7）；M4 只加不减；导入工具兜底 |
| 多责任人完成口径扯皮 | 牵头人制+质量标准必须为可验收交付物句式（语言库句式约束） |
| 归口绑定与人事变动脱节 | 建周期强制复核提示；无绑定分类阻断提交 |
| L2 无图表库 | 看板 P0 表格式；P1 评估沙箱内 SVG 轻量图 |
| 合并单元格导出细节 | M2 以 33 条实表逐列人工比对作为出口标准 |
| 逾期提醒无调度器 | P0 事件触发+访问时检测补发（§7）；已列为平台侧前置项（§14），调度就绪后升级为到点提醒 |
| 承诺指标无基线 | M4 双轨期采集现行耗时基线，运行后按季出对比（编制→锁定天数、退回率、督办完成率、确认及时率） |

---

## 16. 验收标准

### 16.1 端到端演练（以 9 月实表 33 条为样本）

1. 导入：粘贴 TSV → 分类全命中（容错 2 条人工指定）→ 导入 draft。
2. 配置归口绑定（6 分类）→ 提交全部 → 归口审核：31 通过、1 退回后修改重报通过。
3. 汇总预览 → 提交签发 → 负责人签字 → 锁定：33 条全部 in_progress。
4. 变更：新增 1 条（非 escalated，归口通过即生效）；修改 1 条 escalated（归口通过→负责人追认→生效）；两单均留痕。
5. 督办直插 1 条至锁定周期 → 责任人收到确认提醒。
6. 完成：2 条提报（含材料上传/预览/一次性下载）→ 归口确认；1 条逾期 → 延期申请批准改期；1 条取消留痕。
7. 管理岗兜底驳回 1 条已确认（≤7 日）→ 重报再确认。
8. 导出 scope=all 与 scope=escalated 两份 xlsx，与原表逐列比对一致（含合并单元格、日期格式、责任人顿号连接、备注前缀）。
9. archive：剩余条目全部终态后归档成功；故意留 1 条 in_progress 验证阻断。

### 16.2 权限与安全

- 填报人仅能改本人 draft/returned；归口岗仅见所辖分类；锁定后普通写 409；未授权员工不可见应用入口与 API；跨组织 personId 作为责任人被拒。
- 审计：管理端可完整回溯上述演练全部动作。
- 后端重启数据完整（托管存储），导入重放同一 requestId 不产生重复。

### 16.3 平台工程

- `mop-app validate` 通过；签名、审批、安装、升级链路走管理端网页完成；应用升级仅追加迁移。
- typecheck / 应用测试 / 构建通过；CHANGELOG 与版本按平台版本规则（应用自身独立版本号）。

---

## 附录 A：分类树预置数据（源自 9 月实表）

```
一流地铁目标体系
├─ 安全：应急演练 / 违章违纪 / 一月一警示 / 施工检查 / 防汛防台 / 双重预防体系 / 安全监察 / 运营评估
├─ 优质：设备故障点位梳理 / 安全部件更换 / 安检设备管理 / 安检自主能力提升 / 抱闸开关专项研究
│        电扶梯专项 / 电扶梯年检 / 电扶梯联席会 / 节假日保障 / 生产检修 / 指标管理 / 故障管理 / 财务管理
├─ 高效：创新管理 / 培训管理
└─ 和谐：党建管理 / 绩效管理 / 考勤管理 / 信访舆情管理
班组和部室建设
├─ 班组建设
└─ 部室建设
```

字典支持增删改与停用；历史条目保留原 category_id 快照语义（禁用不删）。

## 附录 B：术语表

| 术语 | 含义 |
| --- | --- |
| 周期 | 月度计划实例，含 §4.1 状态机 |
| 条目 | 一行计划，多责任人+质量标准，§4.2 状态机 |
| 归口 | level2 分类 ↔ 审核岗绑定，审核与完成确认的权限边界 |
| 督办 | 会议布置事项，source=supervision，可直插 locked 周期 |
| 固定项 | 每月重复的模板化条目 |
| 变更 | locked 周期内的 add/update/cancel/extend 微流程（D4） |
| escalated | "拟提报中心"标记，导出与 P2 上卷的筛选依据 |
| 语言库 | 分类级句式模板+示例（D2，P1 先行） |
