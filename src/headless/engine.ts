import { diff3Merge } from 'node-diff3'
import { exclusionMatcher, validPath } from './paths'
import { matchesEntry, sha256 } from './common'
import { makeRecord } from './state-data'
import {
	checkAbort,
	FileEntry,
	FileStore,
	safeError,
	SyncAction,
	SyncActivity,
	SyncConfig,
	SyncError,
	SyncPlan,
	SyncResult,
	SyncState,
} from './types'

export interface EngineOptions {
	local: FileStore
	remote: FileStore
	state: SyncState
	config: SyncConfig
	checkpoint: (state: SyncState) => Promise<void>
	signal?: AbortSignal
	onProgress?: (completed: number, total: number) => void
	onActivity?: (activity: SyncActivity) => void
}

export class SyncEngine {
	constructor(private options: EngineOptions) {}

	async preview(): Promise<SyncPlan> {
		const { local, remote, config, state, signal } = this.options
		this.options.onActivity?.({ phase: 'scan', completed: 0 })
		const ignored = exclusionMatcher(config.exclude)
		const [localEntries, remoteEntries] = await Promise.all([
			local.list(signal),
			remote.list(signal),
		])
		const toMap = (entries: FileEntry[]) => {
			const map = new Map<string, FileEntry>()
			const names = new Set<string>()
			for (const entry of entries) {
				validPath(entry.path)
				if (ignored(entry.path)) continue
				const portable = entry.path.normalize('NFC').toLowerCase()
				if (names.has(portable))
					throw new SyncError(
						'AMBIGUOUS_PATH',
						'存在同名、大小写或 Unicode 冲突文件，已停止同步',
					)
				names.add(portable)
				map.set(entry.path, { ...entry })
			}
			return map
		}
		const locals = toMap(localEntries)
		const remotes = toMap(remoteEntries)
		const remoteHasFiles = [...remotes.values()].some(
			(entry) => entry.kind === 'file',
		)
		const paths = new Set([
			...locals.keys(),
			...remotes.keys(),
			...Object.keys(state.files),
		])
		const portableNames = new Map<string, string>()
		for (const path of [...locals.keys(), ...remotes.keys()]) {
			const portable = path.normalize('NFC').toLowerCase()
			if (portableNames.has(portable) && portableNames.get(portable) !== path)
				throw new SyncError(
					'AMBIGUOUS_PATH',
					'双方存在大小写或 Unicode 路径冲突，已停止同步',
				)
			portableNames.set(portable, path)
		}
		const plan: SyncPlan = { actions: [], unchanged: 0 }
		const candidates = [...paths].sort().filter((path) => !ignored(path))
		for (const [index, path] of candidates.entries()) {
			checkAbort(signal)
			this.options.onActivity?.({
				phase: 'compare',
				completed: index,
				total: candidates.length,
				path,
			})
			const l = locals.get(path)
			const r = remotes.get(path)
			const base = state.files[path]
			const add = (
				type: SyncAction['type'],
				reason?: string,
				merged?: Uint8Array,
			) =>
				plan.actions.push({ type, path, local: l, remote: r, reason, merged })
			if (
				(l?.size || 0) > config.maxFileSize ||
				(r?.size || 0) > config.maxFileSize ||
				(!l && !r && base?.size > config.maxFileSize)
			) {
				add('skip', '文件超过大小上限')
				continue
			}
			if (l?.kind === 'directory' || r?.kind === 'directory') {
				if (l && r && l.kind !== r.kind) add('conflict', '文件和目录类型冲突')
				else if (!l) add('mkdir-local')
				else if (!r) add('mkdir-remote')
				else if (base) add('forget')
				else plan.unchanged++
				continue
			}
			if (r) {
				r.hash =
					base?.remoteRevision === r.revision
						? base.hash
						: sha256(await remote.read(path, signal))
			}
			if (l && r) {
				if (l.hash === r.hash) {
					if (base?.hash === l.hash && base.remoteRevision === r.revision)
						plan.unchanged++
					else add('adopt')
				} else if (base && l.hash === base.hash) add('pull')
				else if (base && r.hash === base.hash) add('push')
				else {
					const merged =
						config.mergeText &&
						base?.baseText !== undefined &&
						/\.(md|txt|json|ya?ml|csv|tsv)$/i.test(path)
							? await this.merge(path, base.baseText, l, r)
							: undefined
					if (merged) add('merge', undefined, merged)
					else
						add(
							'conflict',
							base
								? '双方均已修改，保留双方内容'
								: '首次同步内容不同，保留双方内容',
						)
				}
			} else if (l) {
				if (!base) add('push')
				else if (l.hash !== base.hash) add('conflict', '远端删除与本地修改冲突')
				else
					add(
						config.allowDeletes && remoteHasFiles ? 'delete-local' : 'skip',
						remoteHasFiles
							? '远端已删除；删除传播需明确开启'
							: '远端整体为空，已保护本地文件',
					)
			} else if (r) {
				if (!base) add('pull')
				else if (r.hash !== base.hash) add('conflict', '本地删除与远端修改冲突')
				else
					add(
						config.allowDeletes ? 'delete-remote' : 'skip',
						'本地已删除；删除传播需明确开启',
					)
			} else if (base) add('forget')
		}
		const rank = (type: SyncAction['type']) =>
			type.startsWith('mkdir-') ? 0 : type.startsWith('delete-') ? 2 : 1
		plan.actions.sort(
			(a, b) => rank(a.type) - rank(b.type) || a.path.localeCompare(b.path),
		)
		return plan
	}

	private async merge(
		path: string,
		base: string,
		localEntry: FileEntry,
		remoteEntry: FileEntry,
	) {
		const { local, remote, signal } = this.options
		const [localBytes, remoteBytes] = await Promise.all([
			local.read(path, signal),
			remote.read(path, signal),
		])
		if (
			sha256(localBytes) !== localEntry.hash ||
			sha256(remoteBytes) !== remoteEntry.hash
		)
			throw new SyncError('FILE_CHANGED', '文件在预览过程中变化，请重新同步')
		try {
			const decoder = new TextDecoder('utf-8', { fatal: true })
			const localText = decoder.decode(localBytes)
			const remoteText = decoder.decode(remoteBytes)
			if (localText.includes('\u0000') || remoteText.includes('\u0000'))
				return undefined
			const merged = diff3Merge(localText, base, remoteText, {
				excludeFalseConflicts: true,
				stringSeparator: '\n',
			})
			if (merged.some((region) => !region.ok)) return undefined
			return new TextEncoder().encode(
				merged.flatMap((region) => region.ok || []).join('\n'),
			)
		} catch {
			return undefined
		}
	}

	async run(): Promise<SyncResult> {
		const { local, remote, state, signal, checkpoint, onProgress } =
			this.options
		const startedAt = new Date().toISOString()
		const plan = await this.preview()
		const result: SyncResult = {
			startedAt,
			finishedAt: '',
			completed: 0,
			unchanged: plan.unchanged,
			conflicts: [],
			skipped: [],
			failed: [],
			cancelled: false,
		}
		let processed = 0
		this.options.onActivity?.({
			phase: 'sync',
			completed: 0,
			total: plan.actions.length,
		})
		try {
			for (const action of plan.actions) {
				checkAbort(signal)
				this.options.onActivity?.({
					phase: 'sync',
					completed: processed,
					total: plan.actions.length,
					path: action.path,
					action: action.type,
				})
				if (action.type === 'conflict') result.conflicts.push(action.path)
				else if (action.type === 'skip') result.skipped.push(action.path)
				else {
					try {
						await this.verify(action)
						if (action.type === 'mkdir-local')
							await local.mkdir(action.path, signal)
						else if (action.type === 'mkdir-remote')
							await remote.mkdir(action.path, signal)
						else if (action.type === 'delete-local')
							await local.remove(action.path, action.local!, signal)
						else if (action.type === 'delete-remote')
							await remote.remove(action.path, action.remote!, signal)
						else if (
							action.type === 'push' ||
							action.type === 'merge' ||
							action.type === 'adopt'
						) {
							const content =
								action.merged || (await local.read(action.path, signal))
							if (!action.merged && sha256(content) !== action.local!.hash)
								throw new SyncError('FILE_CHANGED', '本地文件在同步过程中变化')
							if (action.type !== 'adopt')
								await remote.write(action.path, content, action.remote, signal)
							if (action.type === 'merge')
								await local.write(action.path, content, action.local, signal)
							const after = await remote.stat(action.path, signal)
							if (
								!after ||
								after.kind !== 'file' ||
								sha256(await remote.read(action.path, signal)) !==
									sha256(content)
							)
								throw new SyncError(
									'VERIFY_FAILED',
									'上传后的文件校验失败，未更新同步历史',
								)
							state.files[action.path] = makeRecord(
								sha256(content),
								after.revision,
								content,
							)
						} else if (action.type === 'pull') {
							const content = await remote.read(action.path, signal)
							if (sha256(content) !== action.remote!.hash)
								throw new SyncError('FILE_CHANGED', '远端文件在同步过程中变化')
							await local.write(action.path, content, action.local, signal)
							state.files[action.path] = makeRecord(
								sha256(content),
								action.remote!.revision,
								content,
							)
						}
						if (
							[
								'delete-local',
								'delete-remote',
								'forget',
								'mkdir-local',
								'mkdir-remote',
							].includes(action.type)
						)
							delete state.files[action.path]
						result.completed++
					} catch (error) {
						if (signal?.aborted) throw error
						result.failed.push({
							path: action.path,
							message: safeError(error),
						})
					}
				}
				processed++
				onProgress?.(processed, plan.actions.length)
				this.options.onActivity?.({
					phase: 'sync',
					completed: processed,
					total: plan.actions.length,
				})
				if (processed % 10 === 0) await checkpoint(state)
			}
		} catch (error) {
			if (!signal?.aborted) throw error
			result.cancelled = true
		} finally {
			result.finishedAt = new Date().toISOString()
			state.lastRun = result
			await checkpoint(state)
		}
		return result
	}

	private async verify(action: SyncAction) {
		const { local, remote, signal } = this.options
		const [l, r] = await Promise.all([
			local.stat(action.path, signal),
			remote.stat(action.path, signal),
		])
		if (!matchesEntry(l, action.local) || !matchesEntry(r, action.remote))
			throw new SyncError('FILE_CHANGED', '文件自预览后发生变化，已跳过该操作')
	}
}

export function publicPlan(plan: SyncPlan) {
	const summary: Record<string, number> = {}
	for (const action of plan.actions)
		summary[action.type] = (summary[action.type] || 0) + 1
	return {
		unchanged: plan.unchanged,
		total: plan.actions.length,
		summary,
		actions: plan.actions
			.slice(0, 200)
			.map(({ type, path, reason }) => ({ type, path, reason })),
		truncated: plan.actions.length > 200,
	}
}
