import { App, Platform } from 'obsidian'
import {
	MobileVaultContext,
	VaultRuntimeOptions,
	VaultStatus,
} from '../mobile/runtime'
import { SyncConfig, SyncError } from '../headless/types'

export interface VaultSyncContext {
	readonly isMobile: boolean
	hasConfig(): boolean
	credentialRelative(config: SyncConfig): string
	readConfig(): Promise<SyncConfig>
	writeConfig(config: SyncConfig): Promise<void>
	readCookie(config?: SyncConfig): Promise<string>
	saveCookie(config: SyncConfig, value: string): Promise<void>
	acquireLock(): Promise<() => Promise<void>>
	status(): Promise<VaultStatus>
	run(
		mode: 'preview' | 'sync' | 'check',
		options: VaultRuntimeOptions,
	): Promise<VaultRunResult>
}

export type VaultRunResult = Awaited<ReturnType<MobileVaultContext['run']>>

const contexts = new WeakMap<object, Promise<VaultSyncContext>>()

export function vaultSyncContext(app: App): Promise<VaultSyncContext> {
	let context = contexts.get(app.vault)
	if (!context) {
		context = createContext(app)
		contexts.set(app.vault, context)
	}
	return context
}

async function createContext(app: App): Promise<VaultSyncContext> {
	if (!Platform.isDesktopApp) return new MobileVaultContext(app)
	const adapter = app.vault.adapter as { getBasePath?: () => string }
	if (!adapter.getBasePath)
		throw new SyncError('VAULT_MISSING', '知识库目录不可访问')
	const root = adapter.getBasePath()
	const config = await import('../headless/config')
	const runtime = await import('../headless/runtime')
	const state = await import('../headless/state')
	const fs = require('node:fs') as typeof import('node:fs')
	const path = require('node:path') as typeof import('node:path')
	return {
		isMobile: false,
		hasConfig: () => fs.existsSync(config.configPath(root)),
		credentialRelative: (value) => {
			const relative = path
				.relative(root, config.cookiePath(root, value))
				.split('\\')
				.join('/')
			return relative &&
				relative !== '..' &&
				!relative.startsWith('../') &&
				!path.isAbsolute(relative)
				? relative
				: ''
		},
		readConfig: () => config.readConfig(root),
		writeConfig: (value) => config.writeConfig(root, value),
		readCookie: (value = config.defaultConfig) =>
			config.readCookie(root, value),
		saveCookie: (value, cookie) => config.saveCookie(root, value, cookie),
		acquireLock: () => state.acquireLock(root),
		status: () => runtime.localStatus(root),
		run: (mode, options) => runtime.runQuark(root, mode, options),
	}
}
