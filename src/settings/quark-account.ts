import { Notice, Setting } from 'obsidian'
import { defaultConfig, validateConfig } from '../headless/configuration'
import { checkAbort, safeError, SyncConfig } from '../headless/types'
import { QuarkFileStore } from '../headless/quark'
import { obsidianTransport } from '../services/quark-sync.service'
import { vaultSyncContext } from '../services/vault-sync-context'
import BaseSettings from './settings.base'

export default class QuarkAccountSettings extends BaseSettings {
	async display(draft?: SyncConfig) {
		this.containerEl.empty()
		const context = await vaultSyncContext(this.app)
		let config = { ...defaultConfig, exclude: [] as string[] }
		try {
			config = await context.readConfig()
		} catch {}
		if (draft) config = { ...draft, exclude: [...draft.exclude] }
		let cookie = ''
		new Setting(this.containerEl).setName('夸克网盘').setHeading()
		let hasCookie = false
		try {
			await context.readCookie(config)
			hasCookie = true
		} catch {}
		new Setting(this.containerEl)
			.setName('夸克账号')
			.setDesc(
				hasCookie
					? '已有本地登录凭据，可测试连接或重新扫码登录。'
					: '扫码登录后自动保存凭据，再填写同步目录 ID 并保存配置。',
			)
			.addButton((button) =>
				button
					.setButtonText(hasCookie ? '重新扫码登录' : '扫码登录')
					.setCta()
					.onClick(() => {
						if (!config.cookieFile.trim()) {
							new Notice('请填写 Cookie 文件保存位置')
							return
						}
						this.plugin.quarkSyncService.login(async (value, signal) => {
							checkAbort(signal)
							const release = await context.acquireLock()
							try {
								checkAbort(signal)
								await context.saveCookie(config, value)
								await this.plugin.refreshQuarkConfiguration()
							} finally {
								await release()
							}
							new Notice('夸克登录凭据已保存，请确认同步目录并保存配置')
							await this.display(config)
						})
					}),
			)
		new Setting(this.containerEl)
			.setName(context.isMobile ? '免扫码配置' : '手机授权')
			.setDesc(
				context.isMobile
					? '推荐导入电脑生成的加密授权码，手机无需再次扫码。'
					: '电脑登录并保存同步目录后，可生成加密授权码导入手机。',
			)
			.addButton((button) =>
				button.setButtonText('导入电脑授权').onClick(() => {
					this.plugin.quarkSyncService.authorization('import', () =>
						this.display(),
					)
				}),
			)
			.addButton((button) =>
				button
					.setButtonText('导出到手机')
					.setDisabled(!hasCookie)
					.onClick(() => {
						this.plugin.quarkSyncService.authorization('export', () =>
							this.display(),
						)
					}),
			)
		new Setting(this.containerEl)
			.setName('同步目录 ID')
			.setDesc(
				'获取方法：在夸克网页版创建并打开专用文件夹，复制地址栏中最后一级文件夹的 ID。例如「…/abc123-Obsidian」只填「abc123」，不要包含「-文件夹名」或整个网址。填写后点击「保存夸克配置」。',
			)
			.addText((text) =>
				text.setValue(config.rootFolderId).onChange((value) => {
					config.rootFolderId = value.trim()
				}),
			)
		new Setting(this.containerEl)
			.setName('Cookie 文件')
			.setDesc('与命令行和 MCP 共用的本地凭据文件。可使用绝对路径。')
			.addText((text) =>
				text.setValue(config.cookieFile).onChange((value) => {
					config.cookieFile = value.trim()
				}),
			)
		new Setting(this.containerEl)
			.setName('更新 Cookie')
			.setDesc(
				'从你登录的夸克网页获取 Cookie 后粘贴；留空则沿用现有文件。保存后清空输入框。',
			)
			.addText((text) => {
				text.inputEl.type = 'password'
				text.onChange((value) => {
					cookie = value.trim()
				})
			})
		new Setting(this.containerEl)
			.setName('单文件大小上限（MB）')
			.addText((text) =>
				text
					.setValue(String(config.maxFileSize / 1024 / 1024))
					.onChange((value) => {
						config.maxFileSize = Number(value) * 1024 * 1024
					}),
			)
		new Setting(this.containerEl)
			.setName('排除路径')
			.setDesc(
				'每行一条通配规则，例如 attachments/**。配置、凭据和 Git 目录始终排除。',
			)
			.addTextArea((text) =>
				text.setValue(config.exclude.join('\n')).onChange((value) => {
					config.exclude = value
						.split('\n')
						.map((s) => s.trim())
						.filter(Boolean)
				}),
			)
		new Setting(this.containerEl)
			.setName('自动合并文本')
			.setDesc('仅合并双方互不冲突的修改；重叠修改保留双方并报告冲突。')
			.addToggle((toggle) =>
				toggle.setValue(config.mergeText).onChange((value) => {
					config.mergeText = value
				}),
			)
		new Setting(this.containerEl)
			.setName('传播文件删除')
			.setDesc(
				'开启后将删除传播到另一端；本地文件先移到恢复目录，远端文件使用网盘删除接口。',
			)
			.addToggle((toggle) =>
				toggle.setValue(config.allowDeletes).onChange((value) => {
					config.allowDeletes = value
				}),
			)
		new Setting(this.containerEl)
			.setDesc('测试连接可先验证登录；预览使用已保存的同步配置。')
			.addButton((button) =>
				button
					.setButtonText('保存夸克配置')
					.setCta()
					.onClick(async () => {
						let release: (() => Promise<void>) | undefined
						try {
							validateConfig(config)
							release = await context.acquireLock()
							if (cookie) await context.saveCookie(config, cookie)
							else await context.readCookie(config)
							await context.writeConfig(config)
							await this.plugin.refreshQuarkConfiguration()
							new Notice('夸克配置已保存')
							await this.display()
						} catch (error) {
							new Notice(safeError(error))
						} finally {
							await release?.()
						}
					}),
			)
			.addButton((button) =>
				button.setButtonText('测试连接').onClick(async () => {
					button.setDisabled(true)
					let release: (() => Promise<void>) | undefined
					try {
						const testConfig = validateConfig({
							...config,
							rootFolderId: config.rootFolderId || '0',
						})
						release = await context.acquireLock()
						const currentCookie = await context.readCookie(testConfig)
						const store = new QuarkFileStore(
							currentCookie,
							testConfig.rootFolderId,
							obsidianTransport,
							testConfig.maxFileSize,
						)
						await store.testConnection()
						if (store.cookie !== currentCookie)
							await context.saveCookie(testConfig, store.cookie)
						new Notice(
							config.rootFolderId
								? '夸克连接正常，同步目录可访问'
								: '夸克登录有效，请填写同步目录 ID 并保存配置',
						)
					} catch (error) {
						new Notice(safeError(error))
					} finally {
						await release?.()
						button.setDisabled(false)
					}
				}),
			)
			.addButton((button) =>
				button
					.setButtonText('预览同步')
					.onClick(() => this.plugin.quarkSyncService.preview()),
			)
		new Setting(this.containerEl)
			.setName('同步进度')
			.setDesc('查看扫描、文件对比和同步结果。隐藏进度窗口后，同步会继续。')
			.addButton((button) =>
				button
					.setButtonText('查看同步进度')
					.onClick(() => this.plugin.quarkSyncService.showStatus()),
			)
		new Setting(this.containerEl).setName('同步前确认').addToggle((toggle) =>
			toggle
				.setValue(this.plugin.settings.confirmBeforeSync)
				.onChange(async (value) => {
					this.plugin.settings.confirmBeforeSync = value
					await this.plugin.saveSettings()
				}),
		)
		new Setting(this.containerEl)
			.setName('自动同步间隔（秒）')
			.setDesc(
				'0 表示关闭。只在 Obsidian 打开时运行；关闭后可使用 CLI 或 MCP。',
			)
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.autoSyncIntervalSeconds))
					.onChange(async (value) => {
						if (!/^\d+$/.test(value)) return
						this.plugin.settings.autoSyncIntervalSeconds = Math.min(
							Number(value),
							86400,
						)
						await this.plugin.saveSettings()
						await this.plugin.scheduledSyncService.updateInterval()
					}),
			)
		new Setting(this.containerEl)
			.setName('保存后自动同步')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.realtimeSync)
					.onChange(async (value) => {
						this.plugin.settings.realtimeSync = value
						await this.plugin.saveSettings()
					}),
			)
	}
}
