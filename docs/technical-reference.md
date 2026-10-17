# 技术说明

普通使用请先阅读 [README](../README.md)。本文说明删除边界、备份恢复及调试接口。

## 删除流程

1. 校验对话 ID，扫描实际会话目录，检查路径是否仍处于 DSH 数据目录内。
2. 默认拒绝已附着或运行状态无法确定的会话。
3. 在线时通过宿主 `sessionPersistence.open(id, 'write')` 取得写入所有权，并保持到清理结束。
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
| GET | `/dsh-delete-chat/ping` | 插件版本、生效配置和运行检测能力 |
| GET | `/dsh-delete-chat/sessions` | 对话名单、配置、加载保护及 `missing` 标记 |
| DELETE | `/dsh-delete-chat/sessions` | JSON 请求体 `{ "sessionId": "session-..." }` |
| DELETE | `/dsh-delete-chat/sessions/<id>` | 删除指定对话 |
| GET | `/dsh-delete-chat/client.js` | 构建后的普通客户端脚本 |
| POST | `/dsh-delete-chat/diag` | 宿主本地的有限大小诊断上报 |

主要状态码：400 参数或 JSON 无效；409 会话被占用或路径冲突；413 请求体过大；501 系统不支持在线删除；503 宿主服务不可用；500 文件或索引操作失败。

失败响应可能附带 `partial`、`removed`、`backupDir`。`alreadyGone: true` 仍会检查并清理残留索引。

## 客户端诊断

可以在 DSH 的浏览器控制台中使用：

```js
dshDeleteChat.status()
dshDeleteChat.refreshTitles()
dshDeleteChat.openManager()
dshDeleteChat.probe(document.elementFromPoint(x, y))
```

`status()` 中的 `version` 和 `hostVersion` 用于核对客户端与宿主版本，`nativeRowAction` 表示原生操作按钮是否已接入。刷新插件标题缓存不等于刷新宿主会话名单；界面中的“刷新列表”会同步刷新两者。

旧界面的兼容行选择器可通过 `setRowSelectors([...])` 设置，通过 `setRowSelectors(null)` 恢复默认。通常不需要修改。

标题读取会扫描多帧 zstd 日志，限制为 32 MiB 压缩数据、64 MiB 解压文本和 20,000 帧。超过限制或无法解析时使用对话 ID，不将不完整结果当作最新标题。

## 客户端入口

- `client-core.js`：确认、管理窗口、兼容悬浮按钮和共享删除流程。
- `client.js`：由构建脚本生成的普通内联脚本，不手动修改。
- `client-slot.js`：宿主原生模块，注入 `slots` 和 `sessions` 服务，将 React 组件注册到 `sidebar.workspaces.session.row.action`。

原生组件直接接收会话 ID。兼容层优先读取 `data-row-key="session:..."`，只有无明确 ID 的旧界面才使用唯一标题匹配；重复标题不会猜测目标。
