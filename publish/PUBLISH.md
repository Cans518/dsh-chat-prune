# 发布到 DSH 插件商店

本文件记录**实测确认过**的收录规则，不是猜测。

---

## 结论先说

两个商店都以 **GitHub 仓库**为收录主体，不是 npm 包。要上架只需要：

1. 仓库 **公开**
2. 仓库打上 **`dsh-plugin`** topic
3. `package.json` 符合 DSH 插件规范
4. 发一个 Release（带 `.tgz`）

然后等同步。**没有提交表单，也不用开 PR。**

当前状态（2026-10-18 实测）：

| 项 | 状态 |
|---|---|
| 仓库公开 | ✅ `https://github.com/Cans518/dsh-chat-prune` |
| `dsh-plugin` topic | ✅ 已设置 |
| package.json 规范 | ✅ `dsh plugin add` 真实安装通过 |
| Release | ⬜ 待发（见下） |
| 1024Store 收录 | ⬜ 0 命中 |
| dshfind 收录 | ⬜ 0 命中 |

---

## 两个目录的规则（来自实测与官方说明）

### dshfind

来源：[`hikariming/dshfind` README](https://github.com/hikariming/dshfind) 的 *Submit your plugin* 一节，原文：

> Add the `dsh-plugin` topic to your **public** GitHub repository. A scheduled job syncs the topic every day at 02:17 UTC, so a newly tagged repo shows up in the marketplace within about a day — no issue or PR needed.
>
> If it still isn't listed after two syncs, open an issue: the repo may have been filtered as off-topic, or it may be private/archived.

- 公开 API：`https://api.dshfind.com/market/v1/plugins`
- 快照每日刷新；连续两次同步仍未收录就去其仓库开 issue

### 1024Store

站点：`https://deepseek1024.com`

> Every listing passes DSH plugin spec checks and screening first. Then compare community plugins by wrapper-CLI install reports, GitHub stars, releases, and repository activity.

- 公开 API：`https://deepseek1024.com/api/v2/plugins`
- 条目字段（实测返回）：`id`（`owner/repo[/subpath]`）、`name`、`owner`、`url`、`repository`、`category`、`description{en,zh}`、`install`（一条完整的 `dsh plugin --profile web add …` 命令）、`stars`、`pushedAt`、安装统计
- 有**规范检查 + 人工筛查**，比 topic 同步更慢
- 目前没有公开提交页（`/submit` 返回 404），靠索引

两个目录的条目结构在宿主 `dsh-community-market` 里也有对应契约：
`catalog-provider-page.schema.json`（`id` / `name` / `displayName` / `summary` 必填，
`repository` 必须是 GitHub `owner/repo`，`installSource` 必须是 `{kind:"github", commit:"<40位 sha>"}`）。

---

## 发版步骤

前置：`gh` 已认证（`gh auth status` 显示 Logged in）。

```powershell
cd D:\Desktop\test\dsh-delete-chat

# 1. 构建 + 全量测试
npm run build
npm test

# 2. 真实安装验证（用桌面版 CLI 装进临时 profile 并启动）
$env:DSH_ASAR       = 'D:\DSH\DSH NEXT\resources\app.asar'
$env:DSH_EXECUTABLE = 'D:\DSH\DSH NEXT\DSH NEXT.exe'
npm run test:install
#   期望最后一行：DSH_ADD_INSTALL_PASS

# 3. 打包
npm pack --ignore-scripts
#   → dsh-chat-prune-0.4.2.tgz

# 4. 提交并推送
git add -A
git commit -m "release: v0.4.2"
git push origin main

# 5. 打 tag + 发 Release（附件就是那个 tgz）
gh release create v0.4.2 .\dsh-chat-prune-0.4.2.tgz `
  --title "dsh-chat-prune v0.4.2" `
  --notes "会话管理：删除、筛选、批量归档/置顶、保留规则修剪，删除前确认且可选备份。"

# 6. 确认 topic 还在（gh release 不会动它，但确认一下）
gh repo edit Cans518/dsh-chat-prune --add-topic dsh-plugin
```

---

## 验证收录

```powershell
node publish/check-listing.mjs dsh-chat-prune Cans518
```

退出码 0 = 至少一个目录已收录。

也可以直接看：

- 1024Store：`https://deepseek1024.com/plugins?q=dsh-chat-prune`
- dshfind：`https://dshfind.com/zh/plugins/Cans518/dsh-chat-prune`

dshfind 要等 **02:17 UTC**（北京时间 10:17）那次同步。1024Store 的筛查更慢。

---

## 包规范清单（发布前自查）

这些是 `dsh plugin add` 与宿主加载真正依赖的东西：

- [x] `package.json` 有 `name` / `version` / `description` / `license` / `repository` / `homepage` / `author` / `keywords`
- [x] `dsh.manifestVersion: 1`
- [x] `dsh.bundle.patch` 指向实际存在的 `cordis.patch.yml`
- [x] `dsh.client.platform: "web"` 且 `exports["./client"]` 指向存在的入口
- [x] `engines.node` 与 `engines.dsh`（`engines.dsh` 会被商店的兼容性缓存读取）
- [x] `icon` 指向存在的 svg
- [x] `main` 与 `exports["."]` 指向存在的 `lib/index.js`
- [x] **构建产物已提交**（`client.js`），GitHub 直装不跑 `prepack`
- [x] `prepare` 会在 git 安装时重建，避免产物过期
- [x] `files` 白名单不含测试与脚本（tarball 14 个文件）
- [x] `npm pack` 后 `dsh plugin add <tgz>` 能自动启用并启动 Host

`dsh-chat-prune-0.4.2.tgz` 实测结论：

```
DSH_ADD_INSTALL_PASS: automatic enablement, runtime files, actual Host boot and removal verified
```

---

## 常见卡住的原因

| 现象 | 原因 |
|---|---|
| 两个目录都不收录 | 仓库没打 `dsh-plugin` topic，或仓库是 private / archived |
| 打了 topic 仍不收 | 还没到同步点（02:17 UTC）；或连续两次仍无 → 去 `hikariming/dshfind` 开 issue |
| 装了但没反应 | 装了包但 bundle 没进 `dsh.profile.bundles`；用 `dsh plugin add` 会自动加，手抄目录不会 |
| 用户装了旧版 | 仓库里的 `client.js` 没重新提交，GitHub 直装拿到旧产物（已用 `prepare` 兜住） |
| 商店显示不兼容 | `engines.dsh` 范围与用户宿主版本不匹配 |
