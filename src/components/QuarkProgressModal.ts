import { App, ButtonComponent, Modal, Setting } from 'obsidian'
import { SyncActivity, SyncResult } from '../headless/types'

export interface QuarkProgressState {
	running: boolean
	cancelling: boolean
	startedAt: number
	activity?: SyncActivity
	result?: SyncResult
	error?: string
}

export function quarkProgressText(state: QuarkProgressState) {
	if (state.result) {
		const result = state.result
		return `夸克同步${result.cancelled ? '已取消' : '结束'}：完成 ${result.completed}，未变化 ${result.unchanged}，冲突 ${result.conflicts.length}，跳过 ${result.skipped.length}，失败 ${result.failed.length}`
	}
	if (state.error) return state.error
	if (state.cancelling) return '正在取消同步，请等待当前请求结束…'
	const activity = state.activity
	if (!activity || activity.phase === 'scan') return '正在扫描本地和夸克目录…'
	if (activity.phase === 'compare')
		return `正在对比文件：${activity.completed}/${activity.total}`
	return `正在同步：${activity.completed}/${activity.total}`
}

export class QuarkProgressModal extends Modal {
	private statusEl?: HTMLElement
	private pathEl?: HTMLElement
	private elapsedEl?: HTMLElement
	private progressEl?: HTMLProgressElement
	private detailsEl?: HTMLElement
	private cancelButton?: ButtonComponent
	private hideButton?: ButtonComponent
	private timer?: ReturnType<typeof setInterval>
	private displayedResult?: SyncResult

	constructor(
		app: App,
		private state: () => QuarkProgressState,
		private cancel: () => void,
		private closed: () => void,
	) {
		super(app)
	}

	onOpen() {
		this.contentEl.createEl('h2', { text: '夸克同步进度' })
		this.statusEl = this.contentEl.createEl('p', {
			attr: { role: 'status', 'aria-live': 'polite' },
		})
		this.progressEl = this.contentEl.createEl('progress', {
			cls: 'w-full',
			attr: { 'aria-label': '同步进度' },
		})
		this.pathEl = this.contentEl.createEl('p', { cls: 'break-all' })
		this.elapsedEl = this.contentEl.createEl('p')
		this.detailsEl = this.contentEl.createDiv({
			cls: 'max-h-[40vh] overflow-y-auto break-all',
		})
		new Setting(this.contentEl)
			.addButton((button) => {
				this.hideButton = button
					.setButtonText('隐藏')
					.onClick(() => this.close())
			})
			.addButton((button) => {
				this.cancelButton = button
					.setButtonText('取消同步')
					.onClick(() => this.cancel())
			})
		this.timer = setInterval(() => this.update(), 1000)
		this.update()
	}

	update() {
		if (!this.statusEl || !this.progressEl) return
		const state = this.state()
		const text = quarkProgressText(state)
		if (this.statusEl.textContent !== text) this.statusEl.setText(text)
		this.pathEl?.setText(state.running ? state.activity?.path || '' : '')
		const elapsed = Math.floor(Math.max(0, Date.now() - state.startedAt) / 1000)
		this.elapsedEl?.setText(state.running ? `已用时 ${elapsed} 秒` : '')
		const activity = state.activity
		if (activity?.total && activity.total > 0) {
			this.progressEl.max = activity.total
			this.progressEl.value = Math.min(activity.completed, activity.total)
		} else if (state.running) this.progressEl.removeAttribute('value')
		else {
			this.progressEl.max = 1
			this.progressEl.value = state.result && !state.result.cancelled ? 1 : 0
		}
		this.cancelButton?.setDisabled(!state.running || state.cancelling)
		this.cancelButton?.setButtonText(
			state.cancelling ? '正在取消…' : '取消同步',
		)
		this.hideButton?.setButtonText(state.running ? '隐藏' : '关闭')
		if (
			state.result &&
			state.result !== this.displayedResult &&
			this.detailsEl
		) {
			this.displayedResult = state.result
			this.detailsEl.empty()
			const issues = [
				...state.result.conflicts.map((path) => `冲突：${path}`),
				...state.result.skipped.map((path) => `跳过：${path}`),
				...state.result.failed.map((item) => `${item.path}：${item.message}`),
			]
			if (issues.length) {
				const list = this.detailsEl.createEl('ul')
				for (const text of issues.slice(0, 50)) list.createEl('li', { text })
				if (issues.length > 50)
					this.detailsEl.createEl('p', {
						text: '仅显示前 50 项，可在同步状态中查看完整结果。',
					})
			}
		}
		if (!state.running && this.timer !== undefined) {
			clearInterval(this.timer)
			this.timer = undefined
		}
	}

	onClose() {
		if (this.timer !== undefined) clearInterval(this.timer)
		this.timer = undefined
		this.contentEl.empty()
		this.statusEl = undefined
		this.closed()
	}
}
