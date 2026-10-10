import { Modal, Notice, requestUrl } from 'obsidian'
import type AlipanSyncPlugin from '../index'
import { QuarkLoginModal } from '../components/QuarkLoginModal'
import { QuarkAuthorizationModal } from '../components/QuarkAuthorizationModal'
import { onCancelSync } from '../events'
import { vaultSyncContext, VaultRunResult } from './vault-sync-context'
import {
	checkAbort,
	HttpTransport,
	safeError,
	SyncError,
} from '../headless/types'

export const obsidianTransport: HttpTransport = async (request) => {
	checkAbort(request.signal)
	try {
		const body =
			request.body !== undefined && typeof request.body !== 'string'
				? (request.body.buffer.slice(
						request.body.byteOffset,
						request.body.byteOffset + request.body.byteLength,
					) as ArrayBuffer)
				: request.body
		const result = await requestUrl({
			url: request.url,
			method: request.method,
			headers: request.headers,
			body,
			throw: false,
		})
		checkAbort(request.signal)
		const headers: Record<string, string> = {}
		for (const [key, value] of Object.entries(result.headers))
			headers[key.toLowerCase()] = Array.isArray(value)
				? value.join(', ')
				: String(value)
		return {
			status: result.status,
			headers,
			body: new Uint8Array(result.arrayBuffer),
		}
	} catch (error) {
		checkAbort(request.signal)
		if (error instanceof SyncError) throw error
		throw new SyncError('NETWORK', '夸克连接失败，请检查网络后重试')
	}
}

const names: Record<string, string> = {
	push: '上传',
	pull: '下载',
	merge: '合并',
	adopt: '记录共同版本',
	'delete-local': '移入本地恢复目录',
	'delete-remote': '删除远端文件',
	'mkdir-local': '创建本地目录',
	'mkdir-remote': '创建远端目录',
	forget: '更新历史',
	conflict: '冲突，保留双方',
	skip: '跳过',
}

export class QuarkPreviewModal extends Modal {
	constructor(
		plugin: AlipanSyncPlugin,
		private plan: VaultRunResult,
	) {
		super(plugin.app)
	}
	onOpen() {
		this.contentEl.createEl('h2', { text: '夸克同步预览' })
		if ('actions' in this.plan) {
			this.contentEl.createEl('p', {
				text: `待处理 ${this.plan.total} 项，未变化 ${this.plan.unchanged} 项`,
			})
			const list = this.contentEl.createEl('ul')
			for (const item of this.plan.actions)
				list.createEl('li', {
					text: `${names[item.type] || item.type}：${item.path}${item.reason ? `（${item.reason}）` : ''}`,
				})
			if (this.plan.truncated)
				this.contentEl.createEl('p', { text: '仅显示前 200 项。' })
		}
	}
	onClose() {
		this.contentEl.empty()
	}
}

export class QuarkSyncService {
	private controller?: AbortController
	private loginModal?: QuarkLoginModal
	private authorizationModal?: QuarkAuthorizationModal
	private cancelSubscription = onCancelSync().subscribe(() =>
		this.controller?.abort(),
	)
	private progress?: { completed: number; total: number }
	constructor(private plugin: AlipanSyncPlugin) {}

	authorization(mode: 'export' | 'import', onImported: () => Promise<void>) {
		this.loginModal?.close()
		this.authorizationModal?.close()
		this.authorizationModal = new QuarkAuthorizationModal(
			this.plugin,
			mode,
			onImported,
		)
		this.authorizationModal.open()
	}

	login(onLogin: (cookie: string, signal: AbortSignal) => Promise<void>) {
		this.loginModal?.close()
		this.authorizationModal?.close()
		this.loginModal = new QuarkLoginModal(
			this.plugin,
			obsidianTransport,
			onLogin,
		)
		this.loginModal.open()
	}

	async preview() {
		try {
			const context = await vaultSyncContext(this.plugin.app)
			const plan = await context.run('preview', {
				transport: obsidianTransport,
			})
			new QuarkPreviewModal(this.plugin, plan).open()
		} catch (error) {
			new Notice(safeError(error))
		}
	}

	async execute(manual: boolean) {
		if (this.plugin.isSyncing) return false
		this.controller = new AbortController()
		this.plugin.toggleSyncUI(true)
		this.plugin.statusService.updateSyncStatus({ text: '夸克同步：准备中' })
		try {
			const context = await vaultSyncContext(this.plugin.app)
			const result = await context.run('sync', {
				transport: obsidianTransport,
				signal: this.controller.signal,
				onProgress: (completed, total) => {
					this.progress = { completed, total }
					this.plugin.statusService.updateSyncStatus({
						text: `夸克同步：${completed}/${total}`,
					})
				},
			})
			if ('failed' in result) {
				const text = `夸克同步${result.cancelled ? '已取消' : '结束'}：完成 ${result.completed}，冲突 ${result.conflicts.length}，跳过 ${result.skipped.length}，失败 ${result.failed.length}`
				this.plugin.statusService.updateSyncStatus({
					text,
					showNotice: manual || !!result.failed.length,
				})
				return (
					!result.cancelled &&
					!result.failed.length &&
					!result.conflicts.length &&
					!result.skipped.length
				)
			}
			return false
		} catch (error) {
			this.plugin.statusService.updateSyncStatus({
				text: safeError(error),
				isError: true,
				showNotice: true,
			})
			return false
		} finally {
			this.controller = undefined
			this.plugin.toggleSyncUI(false)
		}
	}

	async showStatus() {
		try {
			const status = await (await vaultSyncContext(this.plugin.app)).status()
			const modal = new Modal(this.plugin.app)
			modal.contentEl.createEl('h2', { text: '夸克同步状态' })
			modal.contentEl.createEl('p', {
				text: status.locked ? '该知识库正在同步。' : '当前没有同步任务。',
			})
			if (this.controller && this.progress)
				modal.contentEl.createEl('p', {
					text: `进度：${this.progress.completed}/${this.progress.total}`,
				})
			const result = status.status?.result
			if (result) {
				modal.contentEl.createEl('p', {
					text: `上次同步：${result.finishedAt}`,
				})
				modal.contentEl.createEl('p', {
					text: `完成 ${result.completed}，冲突 ${result.conflicts.length}，跳过 ${result.skipped.length}，失败 ${result.failed.length}${result.cancelled ? '，已取消' : ''}`,
				})
				const list = modal.contentEl.createEl('ul')
				for (const path of result.conflicts)
					list.createEl('li', { text: `冲突：${path}` })
				for (const failed of result.failed)
					list.createEl('li', { text: `${failed.path}：${failed.message}` })
			} else if (status.status?.error)
				modal.contentEl.createEl('p', { text: status.status.error })
			modal.open()
		} catch (error) {
			new Notice(safeError(error))
		}
	}

	unload() {
		this.controller?.abort()
		this.loginModal?.close()
		this.authorizationModal?.close()
		this.cancelSubscription.unsubscribe()
	}
}
