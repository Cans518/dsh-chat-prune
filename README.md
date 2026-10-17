<p align="center">
  <img src="./assets/icon.svg" width="96" height="96" alt="DSH Delete Chat 图标">
</p>

<h1 align="center">DSH Delete Chat</h1>

<p align="center">给 DSH NEXT 加上顺手的对话删除按钮。</p>

<p align="center">
  <a href="./LICENSE">MIT 开源</a> ·
  <a href="#安装">安装</a> ·
  <a href="#怎么用">使用说明</a> ·
  <a href="#常见问题">常见问题</a> ·
  <a href="./CONTRIBUTING.md">参与开发</a>
</p>

这是一个社区插件。在左侧会话列表中删除不再需要的对话，也可以打开“管理对话”，搜索后再删除。

## 能做什么

- **直接删除**：鼠标移到会话行，点击右侧垃圾桶。
- **搜索管理**：按标题、工作区或对话 ID 查找，支持无标题和同名对话。
- **确认后再删**：删除前显示目标和备份设置，避免点错。
- **可选备份**：开启后先备份，再删除；成功时显示备份位置。
- **列表同步更新**：删除后同步更新工作区、置顶、归档和客户端会话名单，无需每删一次就重载界面。
- **跟随 DSH 主题**：确认框、管理窗口和提示使用宿主的主题配色；切换主题时，已打开的窗口也会同步变化。
- **保护已加载的会话**：默认拒绝删除仍被宿主使用的对话。

> **删除不同于归档。** 默认不备份，确认删除后无法通过插件撤销。需要保留恢复机会时，请先[开启备份](#开启备份)。

## 适用环境

| 项目 | 说明 |
|---|---|
| 宿主 | DSH NEXT，需支持客户端插件及工作区服务 |
| 系统 | 当前在线删除支持 **Windows** |
| Node.js | 安装和开发建议使用 **Node.js 24**；最低要求为 20 |
| 兼容性 | 已在本机 DSH NEXT 的真实 Host 和官方界面验证；不同宿主版本仍可能需要适配 |

macOS / Linux 的在线删除目前未开放。Node.js 缺少 zstd 支持时，部分压缩日志的标题可能读不到，仍可按对话 ID 管理。

## 安装

目前提供**从源码打包安装**的方式。以下命令在 PowerShell 中运行，请先准备 Git、Node.js 和已经安装好的 DSH NEXT。

### 1. 下载并打包

```powershell
git clone https://github.com/Cans518/dsh-delete-chat.git
cd dsh-delete-chat
npm ci --legacy-peer-deps
npm run build
npm test
npm pack
```

当前版本会生成 `dsh-delete-chat-0.2.3.tgz`。

### 2. 安装到 DSH profile

先从系统托盘**正常退出 DSH**。仅关闭窗口可能仍在后台运行。

以下以默认数据目录和 `desktop` profile 为例；使用自定义目录或其他 profile 时，请修改对应变量。

```powershell
$dshData = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshData 'profiles\desktop'
$pluginPackage = (Resolve-Path '.\dsh-delete-chat-0.2.3.tgz').Path
npm install --prefix $profileDir --legacy-peer-deps $pluginPackage
```

### 3. 启用并重开 DSH

打开 `$profileDir` 下的 `package.json`，在已有的 `dsh.profile.bundles` 数组末尾加入 `"dsh-delete-chat"`，保留原有条目。修改前建议备份该文件。

插件会自动加载自己的配置，不需要再向 profile 的 `cordis.patch.yml` 重复添加插件条目。

重新打开 DSH，即可使用。从旧版更新时，也需要正常退出并重开一次，以加载新代码。

## 怎么用

### 从侧栏删除

1. 展开左侧工作区。
2. 将鼠标移到要删除的**具体会话行**上。
3. 点击右侧垃圾桶，核对确认窗口中的目标和备份设置。
4. 点击“确认删除”。完成后，会话从列表中消失。

工作区文件夹行本身没有会话删除按钮。按 Escape 或点击“取消”可以放弃操作。

### 从“管理对话”删除

点击右下角的**管理对话**，输入标题、工作区名称或对话 ID。找到目标后点击删除，再确认即可。

同名、无标题、已归档的会话，以及记录已缺失但索引仍有残留的条目，都可以在这里查找。被宿主加载的会话会标记原因并禁止删除。

## 开启备份

在 DSH 正常退出后，编辑安装目录中的：

```text
<DSH 数据目录>/profiles/<profile>/node_modules/dsh-delete-chat/cordis.patch.yml
```

把 `backup: false` 改为 `backup: true`，保存后重新打开 DSH。

| 设置 | 默认值 | 用途 |
|---|---|---|
| `backup` | `false` | `true` 时先完整备份会话目录，备份失败则不删除 |
| `allowRunning` | `false` | 建议保持默认；兼容开关，不能绕过宿主的写入锁 |
| `icon` | `'trash'` | 保留配置项，目前只提供垃圾桶图标 |

备份保存在 `<DSH 数据目录>/deleted-sessions/`，每次备份目录中附有 `restore.json`，记录原路径和恢复说明。备份不会自动清理，请自行管理磁盘空间。

恢复需要先正常退出 DSH，再还原会话目录和对应索引，详见[备份与恢复](./docs/technical-reference.md#备份与恢复)。关闭备份时，插件不提供恢复功能。

## 更新与卸载

**更新：** 在源码目录运行 `git pull`，重新执行安装步骤。用 npm 安装新包前，请另存自己修改过的 `cordis.patch.yml`，更新后按需恢复设置。

已经安装并启用插件时，也可以在构建和测试通过后运行：

```powershell
.\scripts\install-local.ps1 -DshHome $dshData -Profile desktop
```

该脚本会备份旧文件、保留现有插件配置，并校验复制结果；不会自动重启 DSH。支持 `-WhatIf` 预览。

**卸载：** 正常退出 DSH，从 profile 的 `package.json` 中移除 `dsh.profile.bundles` 数组里的 `"dsh-delete-chat"`，再执行：

```powershell
npm uninstall --prefix $profileDir dsh-delete-chat
```

重新打开 DSH。停用插件不会还原此前删除的会话，也不会自动清理备份。

## 常见问题

**看不到垃圾桶？**

先展开工作区，再悬停具体会话行。安装或更新后需要完整退出并重开 DSH。如果侧栏仍没有按钮，可检查右下角是否有“管理对话”，并确认启用的是当前使用的 profile。

**为什么提示“正在运行或已加载”？**

即使当前没有生成内容，宿主也可能仍占用该会话。请先释放它再删除。如果宿主没有关闭会话的入口，可以正常退出并重开 DSH，从“管理对话”中删除尚未打开的历史会话。

**删除后为什么还在另一个列表里？**

0.2.2 已修复客户端旧名单导致的残留显示。更新后完整重启一次 DSH；之后正常删除无需重载页面。若提示“删除已完成，但列表刷新失败”，请在管理窗口点击“刷新列表”，不必再次删除。

**标题显示不出来怎么办？**

无标题、日志格式不兼容或标题扫描超出限制时，会使用对话 ID。可在“管理对话”中按 ID 定位。

**如何反馈问题？**

请在 [Issues](https://github.com/Cans518/dsh-delete-chat/issues) 中说明插件版本、DSH 版本、操作步骤和完整错误提示。截图或日志请先去掉 API Key、对话正文及个人路径。插件不会自动上传对话内容到外部服务。

## 开发与贡献

开发命令、测试范围和目录说明见 [CONTRIBUTING.md](./CONTRIBUTING.md)。接口、删除流程和恢复步骤见[技术说明](./docs/technical-reference.md)，历史问题与验证依据见 [AUDIT.md](./AUDIT.md)。

欢迎提交 Issue 和 Pull Request。项目采用 [MIT License](./LICENSE)；图标 SVG 也包含在本仓库的 MIT 授权中。本项目为社区维护，与 DSH 官方无隶属关系。
