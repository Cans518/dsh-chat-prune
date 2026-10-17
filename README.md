<p align="center">
  <img src="./assets/icon.svg" width="96" height="96" alt="DSH Chat Prune 图标">
</p>

<h1 align="center">DSH Chat Prune</h1>

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
| Node.js | 使用桌面版自带的 `dsh` 命令安装即可；源码开发建议使用 **Node.js 24**，插件最低要求为 20 |
| 兼容性 | 已在本机 DSH NEXT 的真实 Host 和官方界面验证；不同宿主版本仍可能需要适配 |

macOS / Linux 的在线删除目前未开放。Node.js 缺少 zstd 支持时，部分压缩日志的标题可能读不到，仍可按对话 ID 管理。

## 安装

使用 **DSH NEXT 桌面版自带的 `dsh` 命令**安装。先打开过一次桌面应用以初始化 profile，再从系统托盘正常退出 DSH。

在终端执行：

```powershell
dsh plugin --profile desktop add https://github.com/Cans518/dsh-chat-prune/releases/download/v0.3.0/dsh-chat-prune-0.3.0.tgz
```

安装完成后重新打开 DSH。该命令会安装依赖并自动启用插件，**不需要手动编辑 `package.json` 或添加 YAML 挂载条目**。安装包已包含构建产物，不需要用户克隆源码或编译。

> 这版 DSH 的完整命令是 `dsh plugin --profile <profile> add <安装源>`，不是顶层 `dsh add`。`desktop` 是桌面专用 profile，应使用桌面版提供的命令；npm 安装的独立 DSH CLI 不允许管理它。终端找不到 `dsh` 时，请先启用桌面版的命令行入口并重新打开终端。

使用 Web profile 时，将命令中的 `desktop` 换成 `web`。请确保安装到实际使用的 profile。

### 离线安装

也可以从 [Releases](https://github.com/Cans518/dsh-chat-prune/releases) 下载 `.tgz`，使用实际文件路径安装：

```powershell
dsh plugin --profile desktop add "C:\Downloads\dsh-chat-prune-0.3.0.tgz"
```

### 从源码安装

适合开发者。构建完成后仍通过 DSH 命令安装：

```powershell
git clone https://github.com/Cans518/dsh-chat-prune.git
cd dsh-chat-prune
npm ci --legacy-peer-deps
npm run build
npm test
npm pack
$pluginPackage = (Resolve-Path '.\dsh-chat-prune-0.3.0.tgz').Path
dsh plugin --profile desktop add $pluginPackage
```

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
<DSH 数据目录>/profiles/<profile>/node_modules/dsh-chat-prune/cordis.patch.yml
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

### 从本项目 0.2.x 迁移

本项目从 0.3.0 起更名为 **dsh-chat-prune**。npm 上的 `dsh-delete-chat` 属于其他作者，请使用本仓库的 Release 安装地址。

如果安装过本项目的旧版，请先正常退出 DSH，另存旧插件 `cordis.patch.yml` 中自己修改过的设置，再依次执行：

```powershell
dsh plugin --profile desktop remove dsh-delete-chat
dsh plugin --profile desktop add https://github.com/Cans518/dsh-chat-prune/releases/download/v0.3.0/dsh-chat-prune-0.3.0.tgz
```

需要恢复设置时，只将 `backup`、`allowRunning`、`icon` 的值填入新插件的配置文件，保留新版的 `id` 和 `name`；不要用旧文件覆盖整个新文件。然后重新打开 DSH。已有会话和 `deleted-sessions` 备份目录不受改名影响。请勿同时启用新旧两版。

**更新：** 正常退出 DSH，按新版本的 Release 说明重新执行 `dsh plugin --profile desktop add <新安装包地址>`，再打开 DSH。安装前请另存自己修改过的插件 `cordis.patch.yml`，更新后按需恢复设置。

已有依赖但被手动停用的插件，重复 `add` 不会自动重新启用；请到 DSH 的插件管理页启用。

源码开发时，已经安装并启用插件也可在构建和测试通过后运行本地更新脚本：

```powershell
.\scripts\install-local.ps1 -Profile desktop
```

该脚本会备份旧文件、保留现有插件配置，并校验复制结果；不会自动重启 DSH。支持 `-WhatIf` 预览。

**卸载：** 正常退出 DSH，再执行：

```powershell
dsh plugin --profile desktop remove dsh-chat-prune
```

命令会移除依赖和对应的 bundle 选择。重新打开 DSH 即可。卸载不会还原此前删除的会话，也不会自动清理备份。

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

请在 [Issues](https://github.com/Cans518/dsh-chat-prune/issues) 中说明插件版本、DSH 版本、操作步骤和完整错误提示。截图或日志请先去掉 API Key、对话正文及个人路径。插件不会自动上传对话内容到外部服务。

## 开发与贡献

开发命令、测试范围和目录说明见 [CONTRIBUTING.md](./CONTRIBUTING.md)。接口、删除流程和恢复步骤见[技术说明](./docs/technical-reference.md)，历史问题与验证依据见 [AUDIT.md](./AUDIT.md)。

欢迎提交 Issue 和 Pull Request。项目采用 [MIT License](./LICENSE)；图标 SVG 也包含在本仓库的 MIT 授权中。本项目为社区维护，与 DSH 官方无隶属关系。
