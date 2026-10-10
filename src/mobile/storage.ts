import { App, DataAdapter, TFile } from 'obsidian'
import { matchesEntry, randomUUID, sha256 } from '../headless/common'
import { reservedPath, validPath, META_DIR } from '../headless/paths'
import { checkAbort, FileEntry, FileStore, SyncError } from '../headless/types'

export async function ensureDirectory(adapter: DataAdapter, path: string) {
	if (!path) return
	validPath(path)
	const parts = path.split('/')
	for (let index = 1; index <= parts.length; index++) {
		const current = parts.slice(0, index).join('/')
		const stat = await adapter.stat(current)
		if (stat && stat.type !== 'folder')
			throw new SyncError('PATH_TYPE', '父路径不是目录')
		if (!stat) await adapter.mkdir(current)
	}
}

export async function writeMetadata(
	adapter: DataAdapter,
	path: string,
	text: string,
) {
	validPath(path)
	await ensureDirectory(
		adapter,
		path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
	)
	const temporary = `${path}.tmp-${randomUUID()}`
	const backup = `${path}.backup`
	if (await adapter.exists(backup))
		throw new SyncError(
			'METADATA_RECOVERY',
			'同步配置存在未恢复的备份，请先保留并恢复 .backup 文件',
		)
	await adapter.write(temporary, text)
	if ((await adapter.read(temporary)) !== text)
		throw new SyncError('VERIFY_FAILED', '配置暂存校验失败，原配置已保留')
	const old = await adapter.stat(path)
	if (old && old.type !== 'file')
		throw new SyncError('UNSAFE_PATH', '同步配置必须是普通文件')
	let moved = false
	try {
		if (old) {
			await adapter.rename(path, backup)
			moved = true
		}
		await adapter.rename(temporary, path)
	} catch (error) {
		if (moved && !(await adapter.exists(path)))
			await adapter.rename(backup, path)
		throw error
	}
	if (moved) await adapter.remove(backup)
}

export async function readMetadata(
	adapter: DataAdapter,
	path: string,
	limit: number,
) {
	const stat = await adapter.stat(path)
	if (!stat) {
		if (await adapter.exists(path + '.backup'))
			throw new SyncError(
				'METADATA_RECOVERY',
				'同步配置的主文件缺失，请先保留并恢复 .backup 文件',
			)
		return undefined
	}
	if (stat.type !== 'file' || stat.size > limit)
		throw new SyncError('METADATA_INVALID', '同步配置或历史不可读，已停止同步')
	return adapter.read(path)
}

export class VaultFileStore implements FileStore {
	private adapter: DataAdapter
	constructor(
		private app: App,
		private maxFileSize: number,
		private ignored: (path: string) => boolean,
	) {
		this.adapter = app.vault.adapter
	}

	private checkPath(path: string) {
		validPath(path)
		if (this.ignored(path) || reservedPath(path))
			throw new SyncError('RESERVED_PATH', '不能同步配置、凭据或内部文件')
	}

	async read(path: string, signal?: AbortSignal) {
		checkAbort(signal)
		this.checkPath(path)
		const before = await this.adapter.stat(path)
		if (!before || before.type !== 'file' || before.size > this.maxFileSize)
			throw new SyncError(
				'FILE_LIMIT',
				'文件不存在、不是普通文件或超过大小上限',
			)
		const bytes = new Uint8Array(await this.adapter.readBinary(path))
		const after = await this.adapter.stat(path)
		checkAbort(signal)
		if (
			!after ||
			after.size !== before.size ||
			after.mtime !== before.mtime ||
			bytes.byteLength !== before.size
		)
			throw new SyncError('FILE_CHANGED', '文件在读取过程中变化，请重试')
		return bytes
	}

	async stat(
		path: string,
		signal?: AbortSignal,
	): Promise<FileEntry | undefined> {
		checkAbort(signal)
		this.checkPath(path)
		const stat = await this.adapter.stat(path)
		if (!stat) return undefined
		if (stat.type === 'folder')
			return { path, kind: 'directory', size: 0, revision: 'directory' }
		if (stat.type !== 'file')
			throw new SyncError('SPECIAL_FILE', '同步范围存在无法识别的文件类型')
		if (stat.size > this.maxFileSize)
			return {
				path,
				kind: 'file',
				size: stat.size,
				revision: `${stat.size}:${stat.mtime}`,
			}
		const hash = sha256(await this.read(path, signal))
		return { path, kind: 'file', size: stat.size, revision: hash, hash }
	}

	async list(signal?: AbortSignal) {
		const entries: FileEntry[] = []
		const walk = async (path: string) => {
			checkAbort(signal)
			const listed = await this.adapter.list(path)
			for (const child of [...listed.folders, ...listed.files]) {
				validPath(child)
				if (
					(path && !child.startsWith(path + '/')) ||
					child.slice(path ? path.length + 1 : 0).includes('/')
				)
					throw new SyncError(
						'INVALID_PATH',
						'本地目录列表路径异常，已停止同步',
					)
				if (this.ignored(child)) continue
				const item = await this.stat(child, signal)
				if (!item)
					throw new SyncError('FILE_CHANGED', '本地目录列表不完整，请重试')
				entries.push(item)
				if (item.kind === 'directory') await walk(child)
			}
		}
		await walk('')
		return entries
	}

	async mkdir(path: string, signal?: AbortSignal) {
		checkAbort(signal)
		this.checkPath(path)
		const parts = path.split('/')
		for (let index = 1; index <= parts.length; index++) {
			checkAbort(signal)
			const current = parts.slice(0, index).join('/')
			const stat = await this.adapter.stat(current)
			if (stat && stat.type !== 'folder')
				throw new SyncError('PATH_TYPE', '父路径不是目录')
			if (!stat) await this.app.vault.createFolder(current)
		}
	}

	async write(
		path: string,
		content: Uint8Array,
		expected: FileEntry | undefined,
		signal?: AbortSignal,
	) {
		checkAbort(signal)
		this.checkPath(path)
		if (content.byteLength > this.maxFileSize)
			throw new SyncError('FILE_LIMIT', '文件超过大小上限')
		if (!matchesEntry(await this.stat(path, signal), expected))
			throw new SyncError('FILE_CHANGED', '本地文件已变化，已保留现有内容')
		const parent = path.includes('/')
			? path.slice(0, path.lastIndexOf('/'))
			: ''
		if (parent) await this.mkdir(parent, signal)
		if (expected) {
			await ensureDirectory(this.adapter, `${META_DIR}/backups`)
			const previous = await this.read(path, signal)
			if (sha256(previous) !== expected.hash)
				throw new SyncError('FILE_CHANGED', '本地文件已变化，已保留现有内容')
			await this.adapter.writeBinary(
				`${META_DIR}/backups/${randomUUID()}-${path.split('/').pop()}`,
				previous.slice().buffer,
			)
		}
		checkAbort(signal)
		if (!matchesEntry(await this.stat(path, signal), expected))
			throw new SyncError('FILE_CHANGED', '本地文件已变化，已保留现有内容')
		const file = this.app.vault.getAbstractFileByPath(path)
		const bytes = content.slice().buffer
		if (file instanceof TFile) await this.app.vault.modifyBinary(file, bytes)
		else if (!file) await this.app.vault.createBinary(path, bytes)
		else throw new SyncError('PATH_TYPE', '写入路径与已有目录冲突')
		if (sha256(await this.read(path, signal)) !== sha256(content))
			throw new SyncError(
				'VERIFY_FAILED',
				'手机写入校验失败，旧内容已保留在 .vault-sync/backups',
			)
	}

	async remove(path: string, expected: FileEntry, signal?: AbortSignal) {
		checkAbort(signal)
		this.checkPath(path)
		if (
			expected.kind !== 'file' ||
			!matchesEntry(await this.stat(path, signal), expected)
		)
			throw new SyncError('FILE_CHANGED', '本地文件已变化，已取消删除')
		await ensureDirectory(this.adapter, `${META_DIR}/trash`)
		const destination = `${META_DIR}/trash/${randomUUID()}-${path.split('/').pop()}`
		checkAbort(signal)
		const file = this.app.vault.getAbstractFileByPath(path)
		if (file instanceof TFile) await this.app.vault.rename(file, destination)
		else throw new SyncError('FILE_CHANGED', '本地文件索引已变化，请重试')
	}
}
