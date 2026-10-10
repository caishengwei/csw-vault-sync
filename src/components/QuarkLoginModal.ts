import { Modal, Setting } from 'obsidian'
import qrcode from 'qrcode-generator'
import type AlipanSyncPlugin from '../index'
import { QuarkLoginClient } from '../headless/quark-login'
import { checkAbort, HttpTransport, safeError } from '../headless/types'

export class QuarkLoginModal extends Modal {
	private controller?: AbortController
	private statusEl?: HTMLParagraphElement
	private qrEl?: HTMLDivElement

	constructor(
		plugin: AlipanSyncPlugin,
		private transport: HttpTransport,
		private onLogin: (cookie: string, signal: AbortSignal) => Promise<void>,
	) {
		super(plugin.app)
	}

	onOpen() {
		this.contentEl.createEl('h2', { text: '夸克扫码登录' })
		this.contentEl.createEl('p', {
			text: '使用手机夸克 App 扫码，并在手机上确认登录。登录后自动保存凭据。',
		})
		this.qrEl = this.contentEl.createDiv({ cls: 'alipan-text-center' })
		this.statusEl = this.contentEl.createEl('p', {
			attr: { 'aria-live': 'polite' },
		})
		new Setting(this.contentEl)
			.addButton((button) =>
				button.setButtonText('刷新二维码').onClick(() => this.start()),
			)
			.addButton((button) =>
				button.setButtonText('取消').onClick(() => this.close()),
			)
		void this.start()
	}

	private async start() {
		this.controller?.abort()
		const controller = new AbortController()
		this.controller = controller
		const client = new QuarkLoginClient(this.transport)
		this.qrEl?.empty()
		this.statusEl?.setText('正在获取二维码…')
		try {
			const session = await client.create(controller.signal)
			checkAbort(controller.signal)
			const code = qrcode(0, 'M')
			code.addData(session.url)
			code.make()
			this.qrEl?.createEl('img', {
				attr: {
					src: code.createDataURL(4),
					alt: '夸克登录二维码',
					width: '280',
					height: '280',
				},
			})
			while (!controller.signal.aborted) {
				const seconds = Math.max(
					0,
					Math.ceil((session.expiresAt - Date.now()) / 1000),
				)
				this.statusEl?.setText(`等待扫码并确认登录，二维码剩余 ${seconds} 秒`)
				await this.pause(controller.signal)
				const result = await client.poll(controller.signal)
				if (result.state === 'authenticated') {
					this.statusEl?.setText('登录成功，正在保存凭据…')
					await this.onLogin(result.cookie, controller.signal)
					checkAbort(controller.signal)
					this.close()
					return
				}
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				this.qrEl?.empty()
				this.statusEl?.setText(safeError(error))
			}
		} finally {
			client.dispose()
		}
	}

	private async pause(signal: AbortSignal) {
		checkAbort(signal)
		await new Promise<void>((resolve) => {
			const cancel = () => {
				clearTimeout(timer)
				resolve()
			}
			const timer = setTimeout(() => {
				signal.removeEventListener('abort', cancel)
				resolve()
			}, 2000)
			signal.addEventListener('abort', cancel, { once: true })
		})
		checkAbort(signal)
	}

	onClose() {
		this.controller?.abort()
		this.contentEl.empty()
	}
}
