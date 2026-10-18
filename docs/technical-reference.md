# 技术说明

普通使用请先阅读 [README](../README.md)。本文说明删除边界、备份恢复及调试接口。

## 删除流程

1. 校验对话 ID，扫描实际会话目录，检查路径是否仍处于 DSH 数据目录内。
2. 拒绝正在运行的会话；对已跟踪且空闲的 agent 调用原 `AgentHandle.dispose()`，等待宿主完成取消、空闲等待、scope 清理、writer 关闭及注册表摘除。没有 live agent 的只读投影不作为写入占用。
3. 在线时通过宿主 `sessionPersistence.open(id, 'write')` 取得写入所有权，并保持到清理结束；无法完整释放的已加载会话仍被拒绝。
4. 开启备份时，完整复制会话目录并写入恢复说明；失败则中止。
5. 删除会话目录、投影缓存及其同名备份。
6. 通过 `workspaceRegistry` 更新工作区、置顶和归档索引，不直接覆写在线宿主的索引文件。
7. 客户端调用公开 `sessions.refresh()` 更新正式会话名单，再刷新插件名单。

普通会话和归档会话均使用相同删除流程。删除请求在同一数据目录内串行执行。宿主会话名单仍含目标时，会再刷新一次，避免复用删除前开始的在途查询。

文件和宿主索引不构成一个跨系统事务。如果一部分已经删除，后续步骤失败，界面会报告部分完成情况，并保留备份位置。修复原因后可重试；文件已缺失的索引残留仍可从管理窗口清理。

在线物理删除仅支持已验证的 Windows 所有权机制。POSIX 的锁文件可能随目录删除而失效，因此在线删除明确返回 501。

## 备份与恢复

开启备份后，目录结构如下；时间标签包含随机标识以避免碰撞：

```text
<DSH 数据目录>/
  deleted-sessions/
    <时间标签>/
      restore.json
      <sessionId>/
        ...
```

恢复需要手动操作：

1. 正常退出 DSH，先备份当前 `storages/workspace.json`。
2. 阅读对应 `restore.json`，确认对话 ID 和 `originalPath`。
3. 将备份的会话目录复制回 `originalPath`。原路径已存在时先另存，避免覆盖新记录。
4. 根据恢复说明，将 ID 放回 `storages/workspace.json` 对应工作区的 `sessionIds`。需要时重新设置置顶或归档。
5. 重新打开 DSH，确认会话和内容完整。

不要用旧的整个索引直接覆盖新索引，否则可能丢掉之后产生的其他会话索引。`backup: false` 的删除没有插件备份可供恢复。备份不会自动过期。

## HTTP 接口

路由使用宿主的认证转发；客户端使用同源相对路径。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/dsh-chat-prune/ping` | 插件版本、生效配置和运行检测能力 |
| GET | `/dsh-chat-prune/sessions` | 对话名单、配置、加载保护及 `missing` 标记 |
| POST | `/dsh-chat-prune/sources` | `{ "name": "...", "home": "绝对数据根目录", "endpoint": "本机 HTTP 地址（可选）" }`，新增或更新来源 |
| DELETE | `/dsh-chat-prune/sources` | `{ "sourceId": "..." }`，移除来源设置，保留对话数据 |
| POST | `/dsh-chat-prune/sessions/action` | `{ "sessionId": "...", "action": "archive|unarchive|pin|unpin" }`，经宿主工作区服务执行 |
| DELETE | `/dsh-chat-prune/sessions` | JSON 请求体 `{ "sessionId": "session-..." }` |
| DELETE | `/dsh-chat-prune/sessions/<id>` | 删除指定对话 |
| GET | `/dsh-chat-prune/client.js` | 构建后的普通客户端脚本 |
| POST | `/dsh-chat-prune/diag` | 宿主本地的有限大小诊断上报 |

主要状态码：400 参数或 JSON 无效；409 会话被占用或路径冲突；413 请求体过大；501 系统不支持在线删除；503 宿主服务不可用；500 文件或索引操作失败。

失败响应可能附带 `partial`、`removed`、`backupDir`。`alreadyGone: true` 仍会检查并清理残留索引。

名单附带 `managementVersion: 1`、`actions` 能力列表，以及每条记录的 `workspaceKey`、工作区显示名 `workspace`、磁盘 slug `workspaceSlug`、`archived` 和 `pinned`。新版批量窗口遇到没有此管理协议标识的旧宿主会禁用批量操作，要求重启生效。`mtime` 为会话目录内非临时普通文件（含嵌套目录）的最大文件修改时间；`bytes` 为这些文件的总大小。目录联接或符号链接会拒绝扫描，不跟随外部路径。扫描中消失的文件使该行快照失效，跳过该行供下次刷新重新读取。

`canDetectRunning` 表示是否可以查询 agent 的活动状态，缺少它不会禁用全部单条删除或批量预览，在线删除仍需取得写入所有权。名单的 `running` 为兼容既有客户端而保留的保护标志，包含正在运行的 agent 和无法完整释放的已加载会话；`releasable` 表示当前存在可释放的空闲生命周期句柄。只有已加载、没有已知 agent 注册表的目标仍受保护。

`lib/agent-lifecycle.js` 在宿主 registry 的 create/resume 边界保留公开 `AgentHandle`，保留调用方 receiver，从而保持原 Cordis 生命周期所有权。跟踪状态以 `Symbol.for('cordis.original')` 的原始服务对象为键，避免不同调用方代理导致句柄丢失；卸载时恢复方法。只释放与当前 registry agent 身份一致且 `status === 'idle'` 的句柄，释放后重新验证占用，随后仍需取得公开 writer。插件启用前已存在且无法取得句柄的 agent 不会被强制摘除。这一适配经过本机固定宿主实现及真实 Host 流程验证，不保证未来宿主内部 registry 实现不变。

合并名单附带 `sources`，每条记录的 `sourceId`、`sourceHome` 和 `key` 标明来源。当前来源为 `local`，其 `key` 保持原 ID；额外来源的 key 和 workspaceKey 包含来源前缀，保留规则及选择不得仅使用裸会话 ID。额外来源的变更请求须提交 `sourceId`；宿主只从已保存的来源中解析目标，不接受变更请求中的任意路径。`GET /sessions?local=1` 只返回该宿主当前目录，供来源聚合使用，避免递归合并。

来源设置原子写入 `storages/dsh-chat-prune-sources.json`，同进程、同路径的保存串行化。路径先 realpath 并验证 sessions 目录；endpoint 仅接受本机 HTTP 根地址及认证查询参数，连接前和变更前用 ping 核对其 home。未连接的路径只读扫描，不对其他在线宿主的 workspace.json 执行带外写入。已连接来源通过所属宿主执行全部管理操作，保留其备份配置和写入锁；连接响应丢失或 JSON 无法解析时返回 `outcomeUnknown`，批处理停止后续请求。来源列表不包含 endpoint 或认证参数。

JSON 形式的删除请求可附带 `backup: true` 临时开启备份，无法关闭宿主已开启的全局备份。批量客户端同时提交 `protectPinned: true`、预览时的 `expectedMtime` 和 `expectedRevision`；后者是完整文件清单中相对路径、大小、mtime、ctime 的 SHA256 指纹，能检测最新时间不变的文件增删或变化，不是文件内容摘要。宿主在串行队列中及删除前核对，批量模式强制保留运行中及无法安全释放的会话，忽略全局 `allowRunning` 放宽配置。置顶在耗时扫描后及移除前复查；宿主未提供跨元数据和目录的条件删除事务，不能将此复查当成跨进程原子锁。单条删除保留原有配置语义。

管理操作与删除共用每个 home 的串行队列。归档使用宿主默认活动检查，不传强制停止选项；归档清除 pin、unarchive 不恢复 pin，错误向客户端传播。每个请求各自提交，整批不构成原子事务。停止任务仅停止尚未发出的请求，不能回滚当前请求。

保留规则在每个来源的整个工作区按 `mtime` 降序、同时间按完整 key 升序选出最近 N 条，在当前筛选范围内排除保留项、置顶、受保护、缺失、时间未知及未达到天数的条目；未连接来源不自动选中。最终确认预览前重新计算；执行时再次校验每个目标。规则本身只返回候选，不执行操作。

## 客户端诊断

可以在 DSH 的浏览器控制台中使用：

```js
dshChatPrune.status()
dshChatPrune.refreshTitles()
dshChatPrune.openManager()
dshChatPrune.probe(document.elementFromPoint(x, y))
```

`status()` 中的 `version` 和 `hostVersion` 用于核对客户端与宿主版本，`nativeRowAction` 表示原生操作按钮是否已接入。刷新插件标题缓存不等于刷新宿主会话名单；界面中的“刷新列表”会同步刷新两者。

旧界面的兼容行选择器可通过 `setRowSelectors([...])` 设置，通过 `setRowSelectors(null)` 恢复默认。通常不需要修改。

标题读取会扫描多帧 zstd 日志，限制为 32 MiB 压缩数据、64 MiB 解压文本和 20,000 帧。超过限制或无法解析时使用对话 ID，不将不完整结果当作最新标题。

## 客户端入口

- `client-core.js`：确认、管理窗口、兼容悬浮按钮和共享删除流程。
- `client-manager.js`：管理窗口、分页选择、保留规则预览及可停止的逐条批量操作。
- `lib/pruning-policy.js`：纯筛选、排序和保留规则，由构建内联进浏览器脚本。
- `client.js`：由构建脚本生成的普通内联脚本，不手动修改。
- `client-slot.js`：宿主原生模块，注入 `slots` 和 `sessions` 服务，将删除组件注册到 `sidebar.workspaces.session.row.action`，管理入口注册到 `sidebar.footer.action`，根据 `wide` 展示文字或图标。
- `lib/agent-lifecycle.js`：保留并释放原有 AgentHandle，适配 Cordis 服务代理身份。
- `lib/session-sources.js`：来源路径配置、本机宿主校验、合并名单和按来源转发变更。

原生组件直接接收会话 ID。兼容层优先读取 `data-row-key="session:..."`，只有无明确 ID 的旧界面才使用唯一标题匹配；重复标题不会猜测目标。

## 主题适配

弹窗、管理入口、搜索框、按钮及提示使用 DSH 提供的 `--dsw-*` 主题变量：

- 弹窗背景和文字：`--dsw-alias-bg-layer-2`、`--dsw-alias-label-primary`。
- 输入框：`--dsw-alias-bg-layer-1`、`--dsw-alias-border-l4`。
- 危险操作和悬停：`--dsw-alias-state-error-primary`、`--dsw-alias-interactive-bg-hover-danger`。
- 焦点、圆角、阴影和遮罩：宿主对应的 `--dsw-focus-ring-*`、`--dsw-radius-*`、`--dsw-elevation-prominent`、`--dsw-alias-bg-mask-1`。

DSH 在 `body` 上更新当前主题变量，插件作为其后代直接继承；`color-scheme` 也继承宿主设置。浅色、深色及通过这些变量提供的自定义主题，都能在窗口保持打开时更新，不依赖重载或额外监听器。缺少宿主变量的旧环境使用系统颜色作为兜底。
