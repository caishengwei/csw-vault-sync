import { constants, promises as fs } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { assertPrivateDirectory } from './config'
import { META_DIR, reservedPath, validPath } from './paths'
import { checkAbort, FileEntry, FileStore, SyncError } from './types'

export function sha256(content: Uint8Array) {
	return createHash('sha256').update(content).digest('hex')
}

export function matchesEntry(
	current: FileEntry | undefined,
	expected: FileEntry | undefined,
) {
	return !current || !expected
		? current === expected
		: current.kind === expected.kind && current.revision === expected.revision
}

export class LocalFileStore implements FileStore {
	constructor(
		readonly root: string,
		private maxFileSize: number,
		private ignored = reservedPath,
	) {}

	private async checkedPath(path: string) {
		validPath(path)
		if (reservedPath(path))
			throw new SyncError('RESERVED_PATH', '不能同步配置、凭据或内部文件')
		let target = this.root
		for (const part of path.split('/')) {
			target = resolve(target, part)
			const stat = await fs
				.lstat(target)
				.catch((error: NodeJS.ErrnoException) => {
					if (error.code === 'ENOENT') return undefined
					throw error
				})
			if (stat?.isSymbolicLink())
				throw new SyncError('SYMLINK', '同步路径包含符号链接，已停止该操作')
		}
		return target
	}

	async read(path: string, signal?: AbortSignal) {
		checkAbort(signal)
		const target = await this.checkedPath(path)
		const handle = await fs.open(
			target,
			constants.O_RDONLY | constants.O_NOFOLLOW,
		)
		try {
			const before = await handle.stat()
			if (!before.isFile() || before.size > this.maxFileSize)
				throw new SyncError('FILE_LIMIT', '文件超过大小上限或不是普通文件')
			const bytes = await handle.readFile()
			const after = await handle.stat()
			checkAbort(signal)
			if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
				throw new SyncError(
					'FILE_CHANGED',
					'文件在读取过程中发生变化，请重新同步',
				)
			return bytes
		} finally {
			await handle.close()
		}
	}

	async stat(
		path: string,
		signal?: AbortSignal,
	): Promise<FileEntry | undefined> {
		checkAbort(signal)
		const target = await this.checkedPath(path)
		const stat = await fs
			.lstat(target)
			.catch((error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') return undefined
				throw error
			})
		if (!stat) return undefined
		if (stat.isDirectory())
			return { path, kind: 'directory', size: 0, revision: 'directory' }
		if (!stat.isFile())
			throw new SyncError('SPECIAL_FILE', '同步路径不是普通文件或目录')
		if (stat.size > this.maxFileSize)
			return {
				path,
				kind: 'file',
				size: stat.size,
				revision: `${stat.size}:${stat.mtimeMs}`,
			}
		const hash = sha256(await this.read(path, signal))
		return { path, kind: 'file', size: stat.size, revision: hash, hash }
	}

	async list(signal?: AbortSignal): Promise<FileEntry[]> {
		const entries: FileEntry[] = []
		const walk = async (directory: string) => {
			checkAbort(signal)
			const children = await fs.readdir(resolve(this.root, directory), {
				withFileTypes: true,
			})
			for (const child of children) {
				const path = directory ? `${directory}/${child.name}` : child.name
				if (this.ignored(path)) continue
				if (child.isSymbolicLink())
					throw new SyncError(
						'SYMLINK',
						'同步范围内存在符号链接，已停止同步，避免误判为删除',
					)
				if (!child.isDirectory() && !child.isFile())
					throw new SyncError(
						'SPECIAL_FILE',
						'同步范围内存在特殊文件，已停止同步，避免误判为删除',
					)
				const entry = await this.stat(path, signal)
				if (entry) entries.push(entry)
				if (child.isDirectory()) await walk(path)
			}
		}
		await walk('')
		return entries
	}

	async mkdir(path: string, signal?: AbortSignal) {
		checkAbort(signal)
		const target = await this.checkedPath(path)
		await fs.mkdir(target, { recursive: true })
		await this.checkedPath(path)
	}

	async write(
		path: string,
		content: Uint8Array,
		expected: FileEntry | undefined,
		signal?: AbortSignal,
	) {
		checkAbort(signal)
		if (content.byteLength > this.maxFileSize)
			throw new SyncError('FILE_LIMIT', '文件超过大小上限')
		const target = await this.checkedPath(path)
		const parent = path.includes('/')
			? path.slice(0, path.lastIndexOf('/'))
			: ''
		if (parent) await this.mkdir(parent, signal)
		const temporary = resolve(
			dirname(target),
			`.vault-sync-upload-${randomUUID()}`,
		)
		const handle = await fs.open(temporary, 'wx', 0o600)
		try {
			await handle.writeFile(content)
			await handle.sync()
			await handle.close()
			checkAbort(signal)
			if (!matchesEntry(await this.stat(path, signal), expected))
				throw new SyncError('FILE_CHANGED', '本地文件已变化，已保留现有内容')
			await fs.rename(temporary, target)
		} finally {
			await handle.close().catch(() => {})
			await fs.unlink(temporary).catch(() => {})
		}
	}

	async remove(path: string, expected: FileEntry, signal?: AbortSignal) {
		checkAbort(signal)
		if (expected.kind !== 'file')
			throw new SyncError('DIRECTORY_DELETE', '不会自动删除本地目录')
		const target = await this.checkedPath(path)
		await assertPrivateDirectory(resolve(this.root, META_DIR))
		const trash = resolve(this.root, META_DIR, 'trash')
		await assertPrivateDirectory(trash)
		if (!matchesEntry(await this.stat(path, signal), expected))
			throw new SyncError('FILE_CHANGED', '本地文件已变化，已取消删除')
		checkAbort(signal)
		await fs.rename(target, resolve(trash, `${randomUUID()}-${basename(path)}`))
	}
}
