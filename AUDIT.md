# 审计与实现记录

审计日期：2026-10-18。目标：完善删除对话插件，使目标选择、磁盘删除、宿主索引更新和用户反馈形成可用流程。

## 已修复的问题

| 问题 | 修改 | 主要证据 |
|---|---|---|
| 查询 `workspace` 导致内存列表未摘除 | 使用 `workspaceRegistry`，调用 detach/unpin/unarchive；在线不覆写其 JSON | `lib/index.js`；`test/delete-safety.mjs` |
| 首次删除后移到未分组，重载界面才消失 | 删除后通过公开 `ClientSessions.refresh()` 重拉正式会话名单；若加入了删除前的在途刷新且仍含目标，再拉一次；手动刷新也重拉宿主名单 | `client-slot.js`、`client-core.js`；真实 Host 测试展开未分组后，旧实现失败、新实现通过 |
| 真实会话行的 ID 属性被遗漏，按钮依赖过时标题名单 | 接入宿主 `sidebar.workspaces.session.row.action` 原生槽；兼容层读取 `data-row-key="session:..."`，排除 workspace 行和退出克隆 | 宿主 workspace 客户端源码、`client-slot.js`、对应回归测试 |
| 安装后页面仍执行旧缓存脚本，测试通过误认为已生效 | 注入每次重新读文件；暴露 host/client 版本；客户端验证 API 版本，旧宿主明确拒绝删除；新增客户端模块要求完整重启激活 | host/client 协议与状态、自检脚本、真实窗口截图 |
| 全屏悬浮根容器依赖 pointer-events，原输入测试没有检查命中 | 改为零尺寸根容器；浏览器模拟皮肤以 important 覆盖 pointer-events，并实际 click 输入框后键入 | `test/browser-e2e.mjs`，兼容层根容器回归断言 |
| 弹窗固定颜色及浏览器配色与当前宿主主题不一致 | 接入实际 `--dsw-*` 变量，继承宿主 color-scheme；背景、输入、按钮、焦点、遮罩及提示跟随主题 | Chromium 中打开窗口后切换浅色/深色/自定义变量；实际 DSH 设置页切换主题验证 |
| sessions.get 被错误描述为运行状态，且检测失败可能放行 | 保护全部已附着会话，故障时拒绝；声明实际宿主依赖 | `isRunning`、`canDetectRunning`、`inject` |
| 活动检测与删除之间可能发生 resume | 在线持有公开 `sessionPersistence.open(id, 'write')` 的写所有权，finally 关闭；所有权冲突返回 409 | 所有权及失败释放回归测试 |
| 重复标题覆盖、包含匹配猜错目标 | 重复规范化标题标记为歧义；唯一精确匹配；管理窗口按 ID 选择 | `test/client-overlay.mjs`、Chromium 重复标题用例 |
| 原扫描只读前 20 帧，后续改名及跨帧 JSON/UTF-8 丢失 | 有界多帧扫描，保留跨帧文本与解码状态；超限不返回过时标题 | `test/titles-fixture.mjs` |
| 幂等早退遗漏仅剩索引、备份缓存的记录 | 即使原记录已消失也清理索引，列表加入 missing 记录供重试 | 删除安全及部分失败回归测试 |
| 并发删除互相覆盖离线索引 | 每个 home 串行执行插件删除；在线走宿主领域写链 | 并发删除测试 |
| 导出删除函数绕过 ID 校验；路径联接/重复 ID 风险 | 所有入口验证 ID，校验受管路径组件，拒绝重复 ID 与异常缓存目标 | ID、junction、重复目录、缓存路径测试 |
| 索引损坏在删除文件后才发现 | 离线索引与缓存路径先校验；备份失败不删原记录 | 删除安全测试 |
| 部分失败仍假报成功或失去恢复入口 | 抛出有 partial/backupDir 的错误；索引记录保留在管理窗口可重试 | registry 失败回归测试 |
| 成功后按钮永久 disabled、目标漂移、重复提交 | finally 恢复按钮，操作期间固定目标并防重入，合并一帧事件取最后目标 | 客户端行为及真实浏览器测试 |
| 错误只在 tooltip，备份配置未传给客户端 | GET 名单包含生效配置，确认显示备份策略；可见 live status 告知结果/备份/失败 | Chromium 确认、错误重试测试 |
| 只有 hover，重复或无标题没有入口 | 搜索管理窗口、键盘入口、原生确认 dialog、默认取消、焦点恢复、顶部操作栏 | Chromium 键盘及窄屏用例、截图 |
| 定时重试卸载后残留；构建失败可能覆盖产物 | 清理 retry timers/监听器；构建先语法解析再写产物；DOM 就绪后安装 | 客户端生命周期、bundle 测试 |
| 测试导入安装旧副本冒充当前代码；异步断言未等待 | 默认测试只读当前工作区；安装测试独立启用；修正异步 harness；安装预检比较源码并解析真实 YAML | `test/all.mjs`、`test/installed-preflight.mjs` |
| node_modules 联接到个人安装，锁文件含本机路径 | 改为正式 registry 依赖，锁定已验证 schemastery 3.18.4，生成可移植锁文件 | `package.json`、`package-lock.json` |
| 重启脚本按进程名强杀所有实例 | 仅等待指定可执行文件的指定进程正常退出，超时失败；不终止进程 | `restart-watcher.ps1/.cmd` |

## 宿主实现依据

以下为已验证安装的 `<DSH 安装目录>/resources/app.asar` 内固定源码快照，经只读核验；不是对所有未来宿主版本的推断。宿主提取源码不包含在公开仓库中。

- `@deepseek-ai/dsh-workspace/lib` 提取稿 `_ws2.js:373`：`super(ctx, "workspaceRegistry")`。`workspace` 是 storage domain 名称。实体 `detachSession`、registry `unpinSession`、`unarchiveSession` 各自走持久化链。
- `_sc.js:1872` 的 attached-session 摘要分别计算 `agentAvailable` 和 `agents.get(id)?.status === "running"`，证明 sessions.get 不能等价于 running。
- `@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:2065`：公开 `SessionPersistence.open(id, access, options?)`。`write` 取得原子 single-writer ownership；冲突抛 SessionAlreadyOwnedError；close 释放所有权。
- `@deepseek-ai/dsh-agent-loop/lib/index.js:1986`：宿主 resume 同样调用 persistence.open(id, "write", …)。
- `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js:614`：Windows 使用内核 semaphore，持锁期间允许目录删除；POSIX flock 依赖 session.lock，删除锁文件会失去排他性。当前在线删除因此明确限制为 Windows。
- `@deepseek-ai/dsh-agent-loop/lib/index.js:1703`：正式 AgentHandle.dispose 按 cancel → whenIdle → scope.dispose → writer.close → detachAgent → detachSession 释放。插件不拥有原始 handle，不能伪造逐 ID dispose。
- `@deepseek-ai/dsh-client-ui-workspace/lib/client.js:2247` 普通会话行为 `data-row-key: session:${node.id}`；`:2323` 渲染 `sidebar.workspaces.session.row.action` 并传入 sessionId/displayTitle。`@deepseek-ai/dsh-client-ui-renderer/lib/client.js:1788` 的注册签名为 register(options, component)，而非把组件放进 options。
- `@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/service.js:253` 的公开 `refresh()` 重拉宿主会话 baseline；`sessions/manager.js:340` 合并在途请求，`:355` 使用权威 baseline 删除已不存在的条目。仅 detach 工作区会把客户端尚存的会话转到未分组，不能替代刷新客户端会话名单。
- `@deepseek-ai/dsh-client-ui-primitives/lib/Modal.module.css:43` 使用 `--dsw-alias-bg-layer-2`、`--dsw-elevation-prominent`；`dsh-client-ui-layout/lib/client.js:548` 的 ThemePresenter 将 color-scheme 写到 html、主题 tokens 写到 body，并响应 theme/change。插件使用同一套变量，直接由 CSS 继承更新。
- 持久化 seam 没有专用删除/保留策略 API；插件执行经所有权保护的带外目录清理。公开 open 可能读取或迁移日志，并不是纯锁操作。

## 验证范围与边界

- 工作区逻辑测试使用临时 home；Chromium 集成通过项目自写的 HTML 注入夹具、真实 HTTP、真实临时会话目录验证交互与删除。该夹具仅模拟本插件使用的内联 body script 协议，真实宿主渲染由独立 Host 测试验证。测试不删除真实用户会话，不重启用户宿主。
- 浏览器测试中的 sessions 服务和 write ownership 服务为契约替身；公开 API 与 Windows 锁语义已另行核验本机宿主源码。它不能替代在每个未来 DSH 版本中的验收。
- 已补充 `test/host-e2e.mjs` 并实际通过：使用本机归档内真正的 Host 和官方前端、嵌入式 Node 24.18.1，在独立 home/profile 通过公开持久化 API 创建冷会话。实际原生按钮显示、取消/确认、持写所有权删除、实时侧栏刷新、归档索引清理及保留其他会话/置顶均通过；浏览器无 pageerror 或 console error。首启向导通过正常“继续/稍后配置”按钮关闭，无强制移除遮罩。
- `npm run test:installed` 检查本机安装副本，旧副本与工作区不同会明确失败。完成源码修改与生成包不代表已替换正在运行的宿主代码；安装后需正常重启再验收。
- 默认 backup=false 是保留的既有行为，确认明确告知不可撤销。只有开启备份才有目录恢复路径；没有虚假的一键撤销承诺。
- 缺少 zstd 的 Node 版本、超出扫描上限或无法解析的日志使用 ID 管理；索引清理和目标 ID 不依赖标题。
- 本项目未声明分层架构。host 模块拥有宿主/文件边界，client 拥有 DOM 与交互，build 只生成普通脚本，测试只消费模块入口。

0.2.0 基线验证：`node test/all.mjs --installed --browser` 汇总 145 项通过、0 失败。随后真实窗口仍无法触发按钮的反馈证明该基线不足以证明实际生效；0.2.1 针对真实 DOM、正式客户端槽及运行时版本补充实现与核验。0.2.2 增加删除后正式会话名单刷新，补充未分组残留和失败重试检查，完整验收 157 项通过。安装后仍需重启宿主激活新代码，独立 profile 验收不等同于现有用户窗口已重启。后续测试以当前源码运行结果为准。

## 回退

更新前保留旧安装目录和插件配置。若新版本不兼容，正常退出 DSH，移除 profile 的 bundle 条目即可停用；或恢复旧安装目录再启动。已删除的数据不随代码回退自动恢复，应按 README 的离线恢复步骤从 deleted-sessions 备份恢复。backup=false 的记录无法由插件恢复。
