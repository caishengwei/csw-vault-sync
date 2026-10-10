import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { assertPrivateDirectory, atomicWrite } from './config'
import { META_DIR } from './paths'
import { SyncError, SyncState } from './types'

import { emptyState, parseState, serializeState } from './state-data'
export { emptyState, makeRecord } from './state-data'

export class DiskState {
	readonly directory: string
	readonly path: string
	constructor(
		vault: string,
		readonly mount: string,
	) {
		this.directory = resolve(vault, META_DIR)
		this.path = resolve(this.directory, `state-${mount}.json`)
	}

	async load(): Promise<SyncState> {
		let text: string
		try {
			const stat = await fs.lstat(this.path)
			if (
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				stat.size > 32 * 1024 * 1024
			)
				throw new Error()
			text = await fs.readFile(this.path, 'utf8')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT')
				return emptyState(this.mount)
			throw new SyncError(
				'STATE_CORRUPT',
				'同步历史不可读，请保留备份后再处理，未进行文件操作',
			)
		}
		return parseState(text, this.mount)
	}

	async save(state: SyncState) {
		await atomicWrite(this.path, serializeState(state))
	}
}

export async function acquireLock(vault: string): Promise<() => Promise<void>> {
	const meta = resolve(vault, META_DIR)
	await assertPrivateDirectory(meta)
	const path = resolve(meta, 'lock')
	try {
		await fs.mkdir(path, { mode: 0o700 })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			throw new SyncError(
				'LOCKED',
				'该知识库已有同步任务。若上次进程异常退出，请确认进程结束后移除 .vault-sync/lock',
			)
		}
		throw error
	}
	const token = randomUUID()
	try {
		await fs.writeFile(
			resolve(path, 'owner.json'),
			JSON.stringify({
				token,
				pid: process.pid,
				host: hostname(),
				startedAt: new Date().toISOString(),
			}),
			{ flag: 'wx', mode: 0o600 },
		)
	} catch (error) {
		await fs.rmdir(path).catch(() => {})
		throw error
	}
	return async () => {
		const owner = JSON.parse(
			await fs.readFile(resolve(path, 'owner.json'), 'utf8'),
		)
		if (owner.token !== token)
			throw new SyncError('LOCK_CHANGED', '同步锁发生变化，未移除其他任务的锁')
		await fs.unlink(resolve(path, 'owner.json'))
		await fs.rmdir(path)
	}
}
