# 参与开发

欢迎反馈问题、完善文档或提交修复。开始前请阅读 [README](./README.md) 中的功能和兼容范围。

## 本地开发

建议使用 Node.js 24：

```powershell
npm ci --legacy-peer-deps
npm run build
npm test
```

修改 `client-core.js`、`client-manager.js` 或 `lib/pruning-policy.js` 后需要运行 `npm run build`，并一同提交生成的 `client.js`。构建会按依赖顺序将这些模块内联为普通脚本。`client-slot.js` 是单独的宿主模块，不由该脚本生成。

## 测试

| 命令 | 验证范围 |
|---|---|
| `npm test` | 当前源码的逻辑、客户端状态、导出、删除安全和日志解析；不读取真实用户 home |
| `npm run test:browser` | Chromium 单条及批量交互、真实 HTTP、保留规则、停止任务、临时会话目录 |
| `npm run test:installed` | 本机已安装插件的配置、代码一致性及宿主集成；需要本地 DSH 环境 |
| `npm run test:host` | 实际 DSH Host 与官方前端，使用独立临时 home/profile；需要 Windows 和本地 DSH |
| `npm run test:install` | 打包后调用真实 DSH CLI，验证安装、自动启用、Host 启动与卸载；需要 Windows 和桌面版运行时 |

首次运行浏览器测试前：

```powershell
npx playwright install chromium
```

真实宿主测试需要设置自己的安装路径：

```powershell
$env:DSH_ASAR = 'C:\path\to\DSH NEXT\resources\app.asar'
$env:DSH_EXECUTABLE = 'C:\path\to\DSH NEXT\DSH NEXT.exe'
npm run test:host
```

这些路径仅为占位示例，请替换为本机实际位置。真实 Host 测试不会调用模型或删除现有用户对话；测试材料写入被 Git 忽略的 `.diagnostics/`。可通过 `node test/all.mjs --installed --browser --host` 组合验证本机环境。

浏览器测试覆盖已打开窗口随浅色、深色及自定义主题变量即时变化，以及页面卸载恢复时的名单请求和批量操作隔离。真实 Host 测试通过 DSH 设置页切换浅色和深色，核对实际弹窗配色；兼容旧版 API Key 向导和 2.0.19-next 的“开始使用”向导、账号菜单设置入口，均通过正常按钮进入。隔离 Host 缺少可选 Explorer 图标时，测试仅为该图标提供夹具，不替换主题、会话或删除接口。

多来源浏览器测试覆盖新增和持久化路径、两个目录下相同 ID 的独立选择、合并预览、只删除指定来源、未连接来源的只读状态与移除来源保留数据。生命周期逻辑测试覆盖 caller proxy 身份、原始所有权、预览后开始运行的拒绝及先释放再持锁；真实 Host 测试先打开记录并切换到另一会话，再从侧栏删除已打开的历史记录。

安装测试复用 `DSH_ASAR` / `DSH_EXECUTABLE`，默认从该安装的 `resources/runtime/<arch>/primary-runtime/dependencies/` 查找 Node 和 pnpm；布局不同时可设置 `DSH_NODE_EXECUTABLE`、`DSH_PNPM`。`DSH_INSTALL_SPEC` 可指定待验证的远程安装源，未指定时使用本项目打包的 `.tgz`。测试使用独立的 `.diagnostics/cli-install-*`，不修改现有用户 profile。

组合安装验收时，先执行 `npm pack`，再运行 `node test/all.mjs --installed --browser --host --install`。

验证 0.2.x 改名迁移时，可将 `DSH_LEGACY_INSTALL_SPEC` 设置为本项目旧版 Release 的 `.tgz` 地址或本地路径，再运行 `npm run test:install`。该用例在独立 profile 中安装旧版、移除旧 bundle，然后安装新版并启动真实 Host，同时检查既有备份文件不受影响；不迁移用户现有安装。只验证新包时不设置此变量即可。

## 目录

```text
assets/        项目图标
docs/          技术和恢复说明
lib/           宿主服务与删除逻辑
scripts/       构建、安装工具
test/          逻辑、浏览器和宿主集成测试
client-core.js 客户端共享逻辑
client-manager.js 管理窗口、选择、预览和批量任务
client-slot.js 原生侧栏操作组件
client.js      生成的客户端脚本
```

`lib/pruning-policy.js` 是浏览器与逻辑测试共用的纯筛选/保留规则。宿主状态变更通过 `workspaceRegistry` 的公开方法执行，删除继续持有写入所有权。不要在在线管理操作中直接重写工作区 JSON。

## 提交建议

- 一个改动解决一个明确问题，说明修改前后的行为。
- 行为修复附上能复现原问题的测试，列出实际运行的验证命令。
- 不提交 `.env`、API Key、真实对话、个人数据、日志或从宿主提取的源码。
- 不用用户的真实会话做删除测试；使用临时目录和虚构数据。
- 新增宿主接口调用时，核对对应版本的公开接口，并说明兼容范围。

## 报告问题

请提供插件版本、DSH 版本、系统、复现步骤、预期行为和实际行为。日志及截图请先脱敏，尤其是 API Key、对话正文和个人目录。

## 授权

提交到本项目的代码和图标按仓库的 [MIT License](./LICENSE) 授权。
