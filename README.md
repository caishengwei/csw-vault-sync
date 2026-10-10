# Vault Sync

基于 Alipan Sync 定制的 Obsidian 同步插件。夸克支持桌面与移动端，并提供不需要打开 Obsidian 的桌面 CLI 与 MCP。阿里云盘保留上游插件原有同步功能。

## 三个入口

| 入口          | 支持                                       |
| ------------- | ------------------------------------------ |
| Obsidian 插件 | 桌面与移动端夸克同步；保留阿里云盘入口     |
| CLI           | 夸克连接检查、预览、双向同步、本地状态查询 |
| MCP（stdio）  | 夸克预览、异步同步任务、状态和取消         |

夸克的三个入口共用 `src/headless` 同步规则和知识库内 `.vault-sync` 配置格式。桌面插件、CLI、MCP 共用本地历史与跨进程锁；移动端使用 Obsidian 文件接口与设备内同步锁，各设备的历史独立保存在本地。MCP 不依赖 Obsidian 或持续运行的同步守护进程。

## 构建与测试

需要 Node.js 20+ 和 pnpm：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run test
```

产物为 `dist/main.js`、`dist/styles.css`、`dist/manifest.json` 和独立可执行文件 `dist/vault-sync.cjs`。CLI 已打包运行依赖，单独使用该文件时只需 Node.js 20+。

## 安装插件

将三个插件产物复制到 `<知识库>/.obsidian/plugins/csw-vault-sync/`，重载 Obsidian 后启用 **Vault Sync**。这是独立插件 ID，不覆盖原来的 Alipan Sync。使用定制插件同步同一知识库前，关闭原插件的自动同步。

在插件设置中选择夸克，点击「扫码登录」，使用手机夸克 App 扫码并确认。登录成功后自动保存本地凭据；二维码过期可刷新，关闭弹窗会停止等待。然后填写专用同步文件夹 ID，点击「保存夸克配置」。也保留手动填写网页 Cookie 或已有 Cookie 文件的方式。Cookie 不保存在插件的 `data.json` 中，二维码在本地生成。

登录后可先点击「测试连接」验证账号。填写同步目录后，该按钮同时验证目录是否可访问；同步预览需要先保存完整配置。

获取同步目录 ID：在夸克网页版创建并打开专用文件夹，从地址栏取最后一级文件夹对应的 ID。例如 `…/abc123-Obsidian` 只填写 `abc123`，去掉后面的 `-文件夹名`，不要填写整个网址。填入插件后点击「保存夸克配置」。

手机手动同步会立即打开进度窗口，显示扫描、文件对比、当前文件、同步数量和最终结果。可隐藏窗口继续同步，再从设置中的「查看同步进度」或命令面板重新打开；取消时会先显示等待当前请求结束，结束后才释放同步锁。自动同步不弹出进度窗口。

新安装默认关闭自动同步；插件设置中的定时与保存后同步只在 Obsidian 打开时运行。开发记忆写入不会调用任何同步入口。

## 手机安装与免扫码授权

本项目为公开仓库：[caishengwei/csw-vault-sync](https://github.com/caishengwei/csw-vault-sync)。通过 BRAT 安装和更新，无需配置私仓 Token。

1. 在手机 Obsidian 的社区插件中安装并启用 [BRAT](https://github.com/TfTHacker/obsidian42-brat)。
2. 在 BRAT 添加仓库 `caishengwei/csw-vault-sync`，安装最新 Release，再启用 **Vault Sync**。
3. 已安装时，在 BRAT 检查 beta 插件更新，将 **Vault Sync** 更新到最新版本。
4. 电脑端先完成登录并保存同步目录，点击「导出到手机」，设置至少 8 位密码并生成授权码。
5. 把加密授权码传到手机，在手机 Vault Sync 中点击「导入电脑授权」，粘贴授权码并输入同一密码。导入前验证账号和目录，成功后可先预览同步。

授权码使用 PBKDF2-SHA256 与 AES-256-GCM，24 小时内可导入；它包含登录凭据、同步目录及排除规则，不包含笔记、同步历史或电脑绝对路径。导入后关闭删除传播。密码不会写入配置。手机也保留扫码及手动 Cookie 配置入口。

移动端已有文件被覆盖前会保存在 `.vault-sync/backups/`；删除先移入 `.vault-sync/trash/`。若异常退出留下 `.backup` 配置文件，先保留并恢复该文件再继续。

## CLI

只需以下两种配置方式之一：插件设置保存配置，或运行 `init`。Cookie 通过本地文件读取，不接受包含 Cookie 原值的命令参数。

```sh
node dist/vault-sync.cjs init \
  --vault "/path/to/vault" \
  --root-id "夸克文件夹ID" \
  --cookie-file "/path/to/quark-cookie.txt"

node dist/vault-sync.cjs check --vault "/path/to/vault"
node dist/vault-sync.cjs preview --vault "/path/to/vault"
node dist/vault-sync.cjs sync --vault "/path/to/vault"
node dist/vault-sync.cjs status --vault "/path/to/vault"
```

输出为 JSON。退出码：`0` 表示正常完成，`1` 表示配置、连接或启动失败，`2` 表示执行后仍有冲突、跳过、失败或取消。

删除传播默认关闭。确认需要传播文件删除后，可在插件中开启，或为单次 `preview` / `sync` 增加 `--allow-delete`。远端整体为空时仍保护已有本地文件。

## MCP

使用任意支持本地 stdio MCP 的客户端，添加服务器配置：

```json
{
	"mcpServers": {
		"vault-sync": {
			"command": "node",
			"args": [
				"/absolute/path/to/dist/vault-sync.cjs",
				"mcp",
				"--vault",
				"/absolute/path/to/vault"
			]
		}
	}
}
```

服务器绑定启动时指定的知识库；工具不接受其他知识库路径，不返回 Cookie 或笔记内容：

- `sync_preview({allowDeletes?})`：预览文件动作，最多返回 200 项。
- `sync_run({allowDeletes?})`：启动任务并立即返回 `jobId`。
- `sync_status({})`：查询任务进度、结果和本地锁状态。
- `sync_cancel({jobId})`：取消该服务器创建的指定任务，保留已完成操作。

`sync_run` 完成后应检查 `conflicts`、`skipped`、`failed` 和 `cancelled`，不能只依据 MCP 调用成功判断同步成功。

## 同步行为与恢复

- 首次同步同路径内容不同，保留双方并报告冲突；不按时间戳选一方覆盖。
- 后续根据共同版本和内容散列判断修改。文本只有不重叠的修改才自动合并；无法合并时原文件保持不变。
- 夸克更新先上传临时文件、读取校验，再用重命名替换旧版本。替换失败尝试恢复旧文件；异常中断可能留下 `.vault-sync-upload-*` 或 `.vault-sync-backup-*`，这些文件不参与后续同步。必要时在网盘中手动恢复备份。
- 本地文件删除先移入 `.vault-sync/trash/`。远端使用夸克删除接口，不清空网盘回收站。空目录只创建，不自动删除。
- `.vault-sync`、`.obsidian`、`.git`、`.trash`、凭据文件、临时上传及备份始终排除；另支持自定义通配规则和文件大小上限。
- 同步范围内出现符号链接或特殊文件时停止同步，避免把无法读取的路径误判为删除；可用排除规则跳过这些路径。拒绝路径穿越和大小写、Unicode 归一化冲突。跨设备没有云端事务锁，服务器接口也不提供条件写入；检测到预览后文件变化时跳过该操作。
- 如果进程异常退出，先确认相关插件、CLI 和 MCP 同步任务均已结束，再移除 `.vault-sync/lock`。不要在同步运行时移除锁。
- `.vault-sync/state-*.json` 是按账号和夸克目录隔离的历史与文本合并基线。损坏时停止同步，不把不可读历史当成首次同步；处理前保留这些文件的备份。

## 夸克接入限制

夸克适配依赖非官方 Cookie 接口，Cookie 失效需要更新，接口变化可能需要维护；参考 [OpenList 夸克驱动文档](https://doc.oplist.org/guide/drivers/quark) 和 [实现](https://github.com/OpenListTeam/OpenList/tree/main/drivers/quark_uc)。桌面真实账号扫码、连接及临时文件的上传、覆盖、下载、回收已验证；131 项自动化测试覆盖模拟夸克 API、隔离文件系统、完整插件的桌面与无 Node 移动环境、电脑授权导入手机和实际 MCP 协议。移动端仍需在真实手机上验证平台网络与文件行为。

## 致谢与许可证

基于 [nowszhao/obsidian-alipan-sync](https://github.com/nowszhao/obsidian-alipan-sync)，上游源自 [Obsidian Nutstore Sync](https://github.com/nutstore/obsidian-nutstore-sync)。夸克协议实现参考 OpenList 的 AGPL-3.0 驱动，保留原作者署名及 [GNU AGPL-3.0](LICENSE)。

个人自用可将本地代码推送到独立 Private 仓库；GitHub 公开仓库的 Fork 保持公开。分发或提供远程网络交互时应遵守 AGPL 对应源码义务。凭据与实际知识库不应进入代码仓库。
