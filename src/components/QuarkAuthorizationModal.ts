import { Modal, Notice, Setting } from 'obsidian'
import type AlipanSyncPlugin from '../index'
import {
	exportAuthorization,
	importAuthorization,
} from '../headless/authorization'
import { QuarkFileStore } from '../headless/quark'
import { checkAbort, safeError } from '../headless/types'
import { obsidianTransport } from '../services/quark-sync.service'
import { vaultSyncContext } from '../services/vault-sync-context'

export class QuarkAuthorizationModal extends Modal {
	private password = ''
	private code = ''
	private controller = new AbortController()

	constructor(
		private plugin: AlipanSyncPlugin,
		private mode: 'export' | 'import',
		private onImported: () => Promise<void>,
	) {
		super(plugin.app)
	}

	onOpen() {
		this.contentEl.createEl('h2', {
			text: this.mode === 'export' ? '导出手机授权' : '导入电脑授权',
		})
		this.contentEl.createEl('p', {
			text:
				this.mode === 'export'
					? '设置授权密码，生成加密授权码。将授权码传到手机，在手机插件中输入同一密码。授权码 24 小时内可导入。'
					: '粘贴电脑插件导出的授权码，输入导出时设置的密码。账号、同步目录和排除规则会一并导入；删除传播默认关闭。',
		})
		new Setting(this.contentEl)
			.setName('授权密码')
			.setDesc('至少 8 个字符，仅用于本次加密授权。')
			.addText((text) => {
				text.inputEl.type = 'password'
				text.onChange((value) => {
					this.password = value
				})
			})
		let output: HTMLTextAreaElement
		new Setting(this.contentEl).setName('加密授权码').addTextArea((text) => {
			output = text.inputEl
			output.rows = 5
			output.readOnly = this.mode === 'export'
			text.onChange((value) => {
				this.code = value.trim()
			})
		})
		const status = this.contentEl.createEl('p', {
			attr: { 'aria-live': 'polite' },
		})
		new Setting(this.contentEl)
			.addButton((button) =>
				button
					.setButtonText(this.mode === 'export' ? '生成授权码' : '导入授权')
					.setCta()
					.onClick(async () => {
						button.setDisabled(true)
						let release: (() => Promise<void>) | undefined
						try {
							const context = await vaultSyncContext(this.plugin.app)
							if (this.mode === 'export') {
								const config = await context.readConfig()
								const cookie = await context.readCookie(config)
								this.code = await exportAuthorization(
									config,
									cookie,
									this.password,
								)
								checkAbort(this.controller.signal)
								output.value = this.code
								status.setText(
									'授权码已生成，复制到手机后输入同一密码即可导入。',
								)
							} else {
								status.setText('正在解密并验证夸克账号…')
								const value = await importAuthorization(
									this.code,
									this.password,
								)
								checkAbort(this.controller.signal)
								const store = new QuarkFileStore(
									value.cookie,
									value.config.rootFolderId,
									obsidianTransport,
									value.config.maxFileSize,
								)
								await store.testConnection(this.controller.signal)
								checkAbort(this.controller.signal)
								release = await context.acquireLock()
								checkAbort(this.controller.signal)
								await context.saveCookie(value.config, store.cookie)
								await context.writeConfig(value.config)
								await this.plugin.refreshQuarkConfiguration()
								await release()
								release = undefined
								new Notice('夸克账号和同步目录已导入，可先预览同步')
								await this.onImported()
								this.close()
							}
						} catch (error) {
							if (!this.controller.signal.aborted)
								status.setText(safeError(error))
						} finally {
							await release?.()
							button.setDisabled(false)
						}
					}),
			)
			.addButton((button) =>
				button
					.setButtonText(this.mode === 'export' ? '复制授权码' : '取消')
					.onClick(async () => {
						if (this.mode === 'import') {
							this.close()
							return
						}
						if (!this.code) {
							status.setText('请先生成授权码')
							return
						}
						try {
							await navigator.clipboard.writeText(this.code)
							status.setText('授权码已复制')
						} catch {
							output.select()
							status.setText('请手动复制已选中的授权码')
						}
					}),
			)
	}

	onClose() {
		this.controller.abort()
		this.password = ''
		this.code = ''
		this.contentEl.empty()
	}
}
