import { AlipanSync, SyncStartMode } from '~/sync'
import logger from '~/utils/logger'
import { stdRemotePath } from '~/utils/std-remote-path'
import waitUntil from '~/utils/wait-until'
import type AlipanSyncPlugin from '..'
import { Notice } from 'obsidian'
import { safeError } from '../headless/types'
import { vaultSyncContext } from './vault-sync-context'

export interface SyncOptions {
	mode: SyncStartMode
}

export default class SyncExecutorService {
	constructor(private plugin: AlipanSyncPlugin) {}

	async executeSync(options: SyncOptions) {
		if (this.plugin.settings.provider === 'quark') {
			return this.plugin.quarkSyncService.execute(
				options.mode === 'manual_sync',
			)
		}
		if (this.plugin.isSyncing || !this.plugin.isAccountConfigured())
			return false
		let release: (() => Promise<void>) | undefined
		try {
			release = await (await vaultSyncContext(this.plugin.app)).acquireLock()
			return await this.executeAlipanSync(options)
		} catch (error) {
			new Notice(safeError(error))
			return false
		} finally {
			await release?.()
		}
	}

	private async executeAlipanSync(options: SyncOptions) {
		if (this.plugin.isSyncing) {
			return false
		}

		// 检查账号配置，未配置时静默返回（自动同步场景）
		if (!this.plugin.isAccountConfigured()) {
			return false
		}

		await waitUntil(() => this.plugin.isSyncing === false, 500)

		// 确保 configDir 始终在排除列表中，因为这个目录里的文件不支持同步
		const configDir = this.plugin.app.vault.configDir
		const exclusions = [configDir, '.vault-sync']
		try {
			const context = await vaultSyncContext(this.plugin.app)
			const credential = context.credentialRelative(await context.readConfig())
			if (credential) exclusions.push(credential)
		} catch {}
		for (const expr of exclusions) {
			if (
				!this.plugin.settings.filterRules.exclusionRules.some(
					(rule) => rule.expr === expr,
				)
			) {
				this.plugin.settings.filterRules.exclusionRules.push({
					expr,
					options: { caseSensitive: false },
				})
			}
		}
		await this.plugin.saveSettings()

		// Build remote storage
		const remoteStorage = await this.plugin.createRemoteStorage?.()
		logger.info(
			`Sync: remoteStorage created, type=${remoteStorage?.type ?? 'undefined'}`,
		)

		if (!remoteStorage) {
			logger.info(
				'Alipan storage could not be created (token missing?). Skipping sync.',
			)
			return false
		}

		// Ensure remote base directory exists before deciding sync tasks.
		const remoteBaseDir = this.plugin.remoteBaseDir
		const normalizedDir = stdRemotePath(remoteBaseDir)
		const exists = await remoteStorage.exists(normalizedDir)
		if (!exists) {
			logger.info(
				`Remote base directory does not exist, creating: ${normalizedDir}`,
			)
			await remoteStorage.createDirectory(remoteBaseDir, {
				recursive: true,
			})
		}

		const sync = new AlipanSync(this.plugin, {
			vault: this.plugin.app.vault,
			remoteBaseDir,
			remoteStorage,
		})

		await sync.start({
			mode: options.mode,
		})

		// Persist Alipan path resolver cache
		if (remoteStorage && 'resolver' in remoteStorage) {
			try {
				const resolver = (
					remoteStorage as {
						resolver: { exportCache(): Record<string, string> }
					}
				).resolver
				this.plugin.settings.alipan = {
					...this.plugin.settings.alipan!,
					pathResolverCache: resolver.exportCache(),
				}
				await this.plugin.saveSettings()
			} catch (e) {
				logger.error('Failed to save Alipan path resolver cache:', e)
			}
		}

		return true
	}
}
