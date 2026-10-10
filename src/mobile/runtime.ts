import type { App } from 'obsidian'
import {
	defaultConfig,
	validateConfig,
	validateCookie,
} from '../headless/configuration'
import { randomUUID } from '../headless/common'
import { SyncEngine, publicPlan } from '../headless/engine'
import { exclusionMatcher, META_DIR, validPath } from '../headless/paths'
import { QuarkFileStore } from '../headless/quark'
import { emptyState, parseState, serializeState } from '../headless/state-data'
import {
	checkAbort,
	HttpTransport,
	safeError,
	SyncConfig,
	SyncError,
	SyncResult,
	SyncActivity,
} from '../headless/types'
import {
	ensureDirectory,
	readMetadata,
	VaultFileStore,
	writeMetadata,
} from './storage'

export interface VaultRuntimeOptions {
	transport: HttpTransport
	signal?: AbortSignal
	allowDeletes?: boolean
	onProgress?: (completed: number, total: number) => void
	onActivity?: (activity: SyncActivity) => void
}

export interface VaultStatus {
	locked: boolean
	configured: boolean
	status?: { running?: boolean; error?: string; result?: SyncResult }
}

export class MobileVaultContext {
	readonly isMobile = true
	private busy = false
	private configured = false
	constructor(private app: App) {}
	private get adapter() {
		return this.app.vault.adapter
	}
	private get configPath() {
		return `${META_DIR}/config.json`
	}
	private get statusPath() {
		return `${META_DIR}/status.json`
	}
	hasConfig() {
		return this.configured
	}
	credentialRelative(config: SyncConfig) {
		return validPath(config.cookieFile)
	}

	async readConfig() {
		const text = await readMetadata(this.adapter, this.configPath, 1024 * 1024)
		if (text === undefined)
			throw new SyncError(
				'CONFIG_MISSING',
				'请先在插件设置中保存夸克账号和同步目录',
			)
		try {
			const config = validateConfig(JSON.parse(text))
			this.credentialRelative(config)
			this.configured = true
			return config
		} catch (error) {
			if (error instanceof SyncError) throw error
			throw new SyncError('INVALID_CONFIG', '同步配置损坏，请重新保存夸克配置')
		}
	}

	async writeConfig(config: SyncConfig) {
		validateConfig(config)
		this.credentialRelative(config)
		await writeMetadata(
			this.adapter,
			this.configPath,
			JSON.stringify(config, null, 2) + '\n',
		)
		this.configured = true
	}

	async readCookie(config: SyncConfig = defaultConfig) {
		const path = this.credentialRelative(config)
		const value = await readMetadata(this.adapter, path, 16384)
		if (value === undefined)
			throw new SyncError('COOKIE_MISSING', '请扫码登录或导入电脑授权')
		return validateCookie(value.trim())
	}

	async saveCookie(config: SyncConfig, value: string) {
		validateCookie(value)
		await writeMetadata(this.adapter, this.credentialRelative(config), value)
	}

	async acquireLock() {
		if (this.busy)
			throw new SyncError('LOCKED', '该知识库已有同步或配置操作，请稍后重试')
		this.busy = true
		const directory = `${META_DIR}/lock`
		const ownerPath = `${directory}/owner.json`
		const token = randomUUID()
		try {
			await ensureDirectory(this.adapter, META_DIR)
			if (await this.adapter.exists(directory))
				throw new SyncError(
					'LOCKED',
					'该知识库已有同步锁；若上次异常退出，请确认任务结束后移除 .vault-sync/lock',
				)
			await this.adapter.mkdir(directory)
			try {
				await this.adapter.write(
					ownerPath,
					JSON.stringify({
						token,
						mobile: true,
						startedAt: new Date().toISOString(),
					}),
				)
			} catch (error) {
				await this.adapter.rmdir(directory, false).catch(() => {})
				throw error
			}
		} catch (error) {
			this.busy = false
			throw error
		}
		return async () => {
			try {
				const owner = JSON.parse(await this.adapter.read(ownerPath))
				if (owner.token !== token)
					throw new SyncError(
						'LOCK_CHANGED',
						'同步锁发生变化，未移除其他任务的锁',
					)
				await this.adapter.remove(ownerPath)
				await this.adapter.rmdir(directory, false)
			} finally {
				this.busy = false
			}
		}
	}

	async status(): Promise<VaultStatus> {
		const text = await readMetadata(this.adapter, this.statusPath, 1024 * 1024)
		return {
			locked: this.busy || (await this.adapter.exists(`${META_DIR}/lock`)),
			configured: await this.adapter.exists(this.configPath),
			status: text ? JSON.parse(text) : undefined,
		}
	}

	async run(mode: 'preview' | 'sync' | 'check', options: VaultRuntimeOptions) {
		const release = await this.acquireLock()
		try {
			const config = await this.readConfig()
			if (options.allowDeletes !== undefined)
				config.allowDeletes = options.allowDeletes
			config.exclude.push(
				this.credentialRelative(config),
				this.app.vault.configDir,
			)
			const ignored = exclusionMatcher(config.exclude)
			const originalCookie = await this.readCookie(config)
			const remote = new QuarkFileStore(
				originalCookie,
				config.rootFolderId,
				options.transport,
				config.maxFileSize,
				ignored,
			)
			if (mode === 'check') return await remote.testConnection(options.signal)
			const statePath = `${META_DIR}/state-${remote.mountIdentity}.json`
			const text = await readMetadata(this.adapter, statePath, 32 * 1024 * 1024)
			const state =
				text === undefined
					? emptyState(remote.mountIdentity)
					: parseState(text, remote.mountIdentity)
			const engine = new SyncEngine({
				local: new VaultFileStore(this.app, config.maxFileSize, ignored),
				remote,
				state,
				config,
				checkpoint: (value) =>
					writeMetadata(this.adapter, statePath, serializeState(value)),
				signal: options.signal,
				onProgress: options.onProgress,
				onActivity: options.onActivity,
			})
			if (mode === 'preview') return publicPlan(await engine.preview())
			checkAbort(options.signal)
			await writeMetadata(
				this.adapter,
				this.statusPath,
				JSON.stringify({ running: true, startedAt: new Date().toISOString() }),
			)
			try {
				const result = await engine.run()
				if (remote.cookie !== originalCookie)
					await this.saveCookie(config, remote.cookie)
				await writeMetadata(
					this.adapter,
					this.statusPath,
					JSON.stringify({ running: false, result }),
				)
				return result
			} catch (error) {
				await writeMetadata(
					this.adapter,
					this.statusPath,
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
}
