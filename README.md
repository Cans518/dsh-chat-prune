<p align="center">
  <img src="./assets/icon.svg" width="96" height="96" alt="DSH Chat Prune">
</p>

<h1 align="center">DSH Chat Prune</h1>

<p align="center">为 DSH NEXT 整理对话：统一查看、批量归档、按规则保留，确认后修剪。</p>

<p align="center">
  <a href="https://github.com/Cans518/dsh-chat-prune/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Cans518/dsh-chat-prune/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/Cans518/dsh-chat-prune/releases/latest"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/Cans518/dsh-chat-prune"></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p align="center">
  <a href="#安装">安装</a> ·
  <a href="#快速上手">快速上手</a> ·
  <a href="./docs/user-guide.md">使用指南</a> ·
  <a href="./CHANGELOG.md">更新记录</a> ·
  <a href="./CONTRIBUTING.md">参与贡献</a>
</p>

DSH Chat Prune 是一个社区维护的对话管理插件。它在 DSH NEXT 侧边栏提供快捷删除和“管理对话”入口，让你在清理之前看清记录、来源、占用和保护状态。

## 功能

| 功能 | 说明 |
|---|---|
| 侧边栏入口 | 删除单条对话，或从底部打开管理窗口；适配展开与折叠状态 |
| 搜索与筛选 | 按标题、工作区、会话 ID、来源、状态、更新时间和大小查找记录 |
| 批量管理 | 跨页选择，批量归档、取消归档、置顶、取消置顶或删除 |
| 保留规则 | 每个工作区保留最近 N 条，只选择早于指定天数的候选记录 |
| 多来源管理 | 合并多个 DSH 数据目录；连接各自的本机宿主后统一操作 |
| 预览与备份 | 执行前核对完整目标，逐条反馈结果，可停止后续操作 |
| 主题适配 | 跟随宿主的浅色、深色和自定义主题即时变化 |

## 运行环境

- **系统：Windows。** macOS / Linux 暂不支持在线删除。
- **宿主：DSH NEXT。** 需要客户端插件、工作区服务和会话持久化服务。
- **安装工具：桌面版自带的 `dsh` 命令。** 源码开发建议使用 Node.js 24，插件最低要求 Node.js 20。

宿主接口可能随版本变化，详细兼容边界见[技术说明](./docs/technical-reference.md)。

## 安装

先启动一次 DSH NEXT 完成 profile 初始化，再从系统托盘正常退出。使用桌面版提供的命令安装：

```powershell
dsh plugin --profile desktop add https://github.com/Cans518/dsh-chat-prune/releases/download/v0.5.0/dsh-chat-prune-0.5.0.tgz
```

重新打开 DSH 即可使用。安装包已包含构建产物，安装时会自动启用插件，无需克隆仓库、编译或手动添加 YAML 挂载条目。

也可以在 [Releases](https://github.com/Cans518/dsh-chat-prune/releases/latest) 下载 `.tgz` 和 `SHA256SUMS.txt`，校验后从本地安装：

```powershell
dsh plugin --profile desktop add "C:\Downloads\dsh-chat-prune-0.5.0.tgz"
```

终端找不到 `dsh` 时，请先启用 DSH NEXT 桌面版的命令行入口，再重新打开终端。使用 Web profile 时将 `desktop` 换成 `web`；请安装到实际使用的 profile。

## 快速上手

### 删除一条对话

展开左侧工作区，鼠标移到具体会话行，点击垃圾桶。核对目标与备份设置后确认删除；Escape 或“取消”可放弃操作。

### 批量整理

1. 点击侧边栏底部的“管理对话”。
2. 搜索或筛选记录，选择本页或全部筛选结果。
3. 选择归档、置顶或删除等操作，点击“预览所选操作”。
4. 核对完整目标清单，再确认执行。结果逐条显示，可停止尚未开始的操作。

### 按规则修剪

在管理窗口点击“保留规则”，例如设置“每个工作区保留最近 10 条，只修剪早于 30 天的记录”，生成候选后预览并确认。

“最近 N 条”按每个来源中的整个工作区计算。置顶、运行中、无法安全释放、记录缺失或时间未知的对话受保护。

多来源连接、筛选规则、备份配置和常见问题见[使用指南](./docs/user-guide.md)。

## 数据安全与备份

**归档保留记录，删除会移除本地记录。** 单条删除默认不备份，批量删除默认勾选备份；确认前请核对设置。

- 删除由数据目录所属宿主执行，并检查会话写入所有权；正在运行或无法安全释放的会话会被拒绝。
- 开启备份时，备份失败则不删除。备份保存在对应数据目录的 `deleted-sessions/`。
- 恢复需要先正常退出 DSH，再按备份中的 `restore.json` 手动还原记录和索引；备份不会自动清理。
- 未连接宿主的额外来源只读展示；移除来源设置不会删除对话。

如何开启全局备份见[使用指南](./docs/user-guide.md#备份设置)，恢复步骤见[技术说明](./docs/technical-reference.md#备份与恢复)。

## 更新与卸载

更新前正常退出 DSH，并另存自己修改过的插件配置；按新 Release 的说明执行 `dsh plugin --profile desktop add <新安装包地址>`，再重新打开 DSH。

卸载：

```powershell
dsh plugin --profile desktop remove dsh-chat-prune
```

卸载不会恢复已删除的记录，也不会清理已有备份。手动停用过的插件需要到 DSH 的插件管理页重新启用。

## 文档

| 文档 | 内容 |
|---|---|
| [使用指南](./docs/user-guide.md) | 多来源连接、筛选、批量操作、备份设置与常见问题 |
| [技术说明](./docs/technical-reference.md) | 宿主接口、删除边界、所有权、备份恢复与客户端入口 |
| [参与贡献](./CONTRIBUTING.md) | 开发环境、测试、目录职责与提交建议 |
| [发布流程](./docs/releasing.md) | 版本更新、自动发布、附件校验与补发 |
| [更新记录](./CHANGELOG.md) | 面向使用者的版本变更 |

## 本地开发

```powershell
git clone https://github.com/Cans518/dsh-chat-prune.git
cd dsh-chat-prune
npm ci --legacy-peer-deps
npm run build
npm test
```

修改客户端源码后需重新构建并提交 `client.js`。CI 在 Windows 的 Node.js 20 和 24 上运行验证；新版本推送到 `main` 并通过检查后，Action 自动打标签、打包并创建 Release。

```text
.github/       CI、发布工作流与 Issue 模板
assets/        项目图标
docs/          使用、技术及维护文档
lib/           宿主接口、会话管理与纯筛选规则
scripts/       构建、校验、安装与维护工具
test/          逻辑、浏览器及宿主集成测试
client-*.js    客户端源模块
client.js      已提交的客户端构建产物
```

## 参与贡献

欢迎通过 [Issues](https://github.com/Cans518/dsh-chat-prune/issues) 报告问题、提出功能建议，或提交 Pull Request。问题反馈请附插件版本、DSH 版本、操作步骤和脱敏后的错误信息。

开始开发前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。测试使用临时目录与虚构记录，请勿使用真实对话验证删除行为。

## 许可证

本项目的代码与图标采用 [MIT License](./LICENSE)。DSH Chat Prune 为社区项目，与 DSH 官方无隶属关系。
