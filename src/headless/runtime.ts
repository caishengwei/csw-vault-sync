import { promises as fs } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import {
	atomicWrite,
	cookiePath,
	readConfig,
	readCookie,
	saveCookie,
} from './config'
import { SyncEngine, publicPlan } from './engine'
import { LocalFileStore } from './local'
import { exclusionMatcher, META_DIR } from './paths'
import { QuarkFileStore } from './quark'
import { acquireLock, DiskState } from './state'
import {
	checkAbort,
	HttpTransport,
	safeError,
	SyncError,
	SyncActivity,
} from './types'

export const nodeTransport: HttpTransport = async (request) => {
	checkAbort(request.signal)
	const controller = new AbortController()
	const cancel = () => controller.abort()
	request.signal?.addEventListener('abort', cancel, { once: true })
	const timeout = setTimeout(cancel, 120000)
	try {
		const response = await fetch(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body as BodyInit | undefined,
			signal: controller.signal,
			redirect: 'manual',
		})
		const chunks: Uint8Array[] = []
		let size = 0
		const reader = response.body?.getReader()
		if (reader) {
			while (true) {
				const part = await reader.read()
				if (part.done) break
				size += part.value.byteLength
				if (size > 512 * 1024 * 1024) {
					await reader.cancel()
					throw new SyncError('RESPONSE_LIMIT', '网盘响应超过大小上限')
				}
				chunks.push(part.value)
			}
		}
		const headers: Record<string, string> = {}
		response.headers.forEach((value, key) => {
			headers[key.toLowerCase()] = value
		})
		return { status: response.status, headers, body: Buffer.concat(chunks) }
	} catch (error) {
		checkAbort(request.signal)
		if (error instanceof SyncError) throw error
		throw new SyncError('NETWORK', '网盘连接失败或超时，请检查网络后重试')
	} finally {
		clearTimeout(timeout)
		request.signal?.removeEventListener('abort', cancel)
	}
}

export async function canonicalVault(path: string) {
	try {
		const root = await fs.realpath(resolve(path))
		if (!(await fs.stat(root)).isDirectory()) throw new Error()
		return root
	} catch {
		throw new SyncError('VAULT_MISSING', '知识库目录不存在或不可访问')
	}
}

export interface RuntimeOptions {
	transport?: HttpTransport
	signal?: AbortSignal
	allowDeletes?: boolean
	onProgress?: (completed: number, total: number) => void
	onActivity?: (activity: SyncActivity) => void
}

export async function runQuark(
	vaultPath: string,
	mode: 'preview' | 'sync' | 'check',
	options: RuntimeOptions = {},
) {
	const vault = await canonicalVault(vaultPath)
	const release = await acquireLock(vault)
	const statusPath = resolve(vault, META_DIR, 'status.json')
	try {
		const config = await readConfig(vault)
		if (options.allowDeletes !== undefined)
			config.allowDeletes = options.allowDeletes
		const credential = relative(vault, cookiePath(vault, config))
			.split('\\')
			.join('/')
		if (
			credential &&
			credential !== '..' &&
			!credential.startsWith('../') &&
			!isAbsolute(credential)
		)
			config.exclude.push(credential)
		const ignored = exclusionMatcher(config.exclude)
		const originalCookie = await readCookie(vault, config)
		const remote = new QuarkFileStore(
			originalCookie,
			config.rootFolderId,
			options.transport || nodeTransport,
			config.maxFileSize,
			ignored,
		)
		if (mode === 'check') return await remote.testConnection(options.signal)
		const disk = new DiskState(vault, remote.mountIdentity)
		const state = await disk.load()
		const engine = new SyncEngine({
			local: new LocalFileStore(vault, config.maxFileSize, ignored),
			remote,
			state,
			config,
			checkpoint: (value) => disk.save(value),
			signal: options.signal,
			onProgress: options.onProgress,
			onActivity: options.onActivity,
		})
		if (mode === 'preview') return publicPlan(await engine.preview())
		await atomicWrite(
			statusPath,
			JSON.stringify({
				running: true,
				pid: process.pid,
				startedAt: new Date().toISOString(),
			}),
		)
		try {
			const result = await engine.run()
			if (remote.cookie !== originalCookie)
				await saveCookie(vault, config, remote.cookie)
			await atomicWrite(statusPath, JSON.stringify({ running: false, result }))
			return result
		} catch (error) {
			await atomicWrite(
				statusPath,
				JSON.stringify({
					running: false,
					error: safeError(error),
					finishedAt: new Date().toISOString(),
				}),
			)
			throw error
		}
	} finally {
		await release()
	}
}

export async function localStatus(vaultPath: string) {
	const vault = await canonicalVault(vaultPath)
	const meta = resolve(vault, META_DIR)
	const directory = await fs
		.lstat(meta)
		.catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') return undefined
			throw error
		})
	if (!directory) return { locked: false, configured: false }
	if (!directory.isDirectory() || directory.isSymbolicLink())
		throw new SyncError('UNSAFE_PATH', '同步配置目录不能是符号链接')
	const read = async (name: string) => {
		const path = resolve(meta, name)
		try {
			const stat = await fs.lstat(path)
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
				throw new Error()
			return JSON.parse(await fs.readFile(path, 'utf8'))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
			throw new SyncError('STATUS_UNREADABLE', '同步状态不可读')
		}
	}
	const lock = await fs
		.lstat(resolve(meta, 'lock'))
		.catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') return undefined
			throw error
		})
	return {
		locked: !!lock,
		configured: !!(await read('config.json')),
		status: await read('status.json'),
	}
}
