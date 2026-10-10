import { App, PluginSettingTab, Setting } from 'obsidian'
import { onSsoReceive } from '~/events/sso-receive'
import i18n from '~/i18n'
import type AlipanSyncPlugin from '~/index'
import { ConflictStrategy } from '~/sync/tasks/conflict-resolve.task'
import { GlobMatchOptions } from '~/utils/glob-match'
import waitUntil from '~/utils/wait-until'
import AlipanAccountSettings from './alipan-account'
import CacheSettings from './cache'
import CommonSettings from './common'
import FilterSettings from './filter'
import LogSettings from './log'
import QuarkAccountSettings from './quark-account'

export enum SyncMode {
	STRICT = 'strict',
	LOOSE = 'loose',
}

/** Which Alipan drive space to use for sync. */
export type AlipanDriveType = 'resource' | 'backup'

export interface AlipanSettings {
	/** OAuth client ID */
	clientId: string
	/** OAuth client secret (optional for some flows) */
	clientSecret?: string
	/** OAuth redirect URI (must match the one configured in Alipan Developer Console) */
	redirectUri?: string
	/** API base URL (defaults to https://openapi.alipan.com) */
	apiBaseUrl?: string
	/** OAuth authorize URL (defaults to https://openapi.alipan.com) */
	authBaseUrl?: string
	/** Active drive ID used for sync (selected from resourceDriveId or backupDriveId). */
	driveId: string
	/** Resource drive ID (对应 "全部文件") */
	resourceDriveId?: string
	/** Backup drive ID (对应 "备份文件") */
	backupDriveId?: string
	/** Which drive space to use. Defaults to 'resource' (全部文件). */
	driveType?: AlipanDriveType
	/** Current access token */
	accessToken: string
	/** Current refresh token */
	refreshToken: string
	/** Token expiration timestamp (ms) */
	expiresAt: number
	/** User ID */
	userId?: string
	/** User name */
	userName?: string
	/** Path resolver cache for persistence */
	pathResolverCache?: Record<string, string>
}

export interface AlipanSyncSettings {
	provider?: 'alipan' | 'quark'
	remoteDir: string
	remoteCacheDir?: string
	useGitStyle: boolean
	conflictStrategy: ConflictStrategy
	confirmBeforeSync: boolean
	confirmBeforeDeleteInAutoSync: boolean
	syncMode: SyncMode
	filterRules: {
		exclusionRules: GlobMatchOptions[]
		inclusionRules: GlobMatchOptions[]
	}
	skipLargeFiles: {
		maxSize: string
	}
	realtimeSync: boolean
	startupSyncDelaySeconds: number
	autoSyncIntervalSeconds: number
	language?: 'zh' | 'en'
	/** Alipan (阿里云盘) configuration */
	alipan?: AlipanSettings
}

let pluginInstance: AlipanSyncPlugin | null = null

export function setPluginInstance(plugin: AlipanSyncPlugin | null) {
	pluginInstance = plugin
}

export function waitUntilPluginInstance() {
	return waitUntil(() => !!pluginInstance, 100)
}

export async function useSettings() {
	await waitUntilPluginInstance()
	return pluginInstance!.settings
}

export class AlipanSettingTab extends PluginSettingTab {
	plugin: AlipanSyncPlugin
	alipanAccountSettings: AlipanAccountSettings
	commonSettings: CommonSettings
	filterSettings: FilterSettings
	logSettings: LogSettings
	cacheSettings: CacheSettings
	warningContainerEl: HTMLElement
	providerContainerEl: HTMLElement
	quarkAccountSettings: QuarkAccountSettings

	subSso = onSsoReceive().subscribe(() => {
		this.display()
	})

	constructor(app: App, plugin: AlipanSyncPlugin) {
		super(app, plugin)
		this.plugin = plugin
		this.warningContainerEl = this.containerEl.createDiv()
		this.providerContainerEl = this.containerEl.createDiv()
		this.quarkAccountSettings = new QuarkAccountSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
		this.alipanAccountSettings = new AlipanAccountSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
		this.commonSettings = new CommonSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
		this.filterSettings = new FilterSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
		this.cacheSettings = new CacheSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
		this.logSettings = new LogSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
	}

	async display() {
		this.warningContainerEl.empty()
		this.providerContainerEl.empty()
		new Setting(this.providerContainerEl)
			.setName('同步网盘')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('quark', '夸克网盘')
					.addOption('alipan', '阿里云盘')
					.setValue(this.plugin.settings.provider || 'alipan')
					.onChange(async (value: 'quark' | 'alipan') => {
						if (this.plugin.isSyncing) {
							await this.display()
							return
						}
						this.plugin.settings.provider = value
						await this.plugin.saveSettings()
						await this.plugin.refreshQuarkConfiguration()
						await this.display()
					}),
			)
		new Setting(this.warningContainerEl)
			.setName(i18n.t('settings.backupWarning.name'))
			.setDesc(i18n.t('settings.backupWarning.desc'))

		if (this.plugin.settings.provider === 'quark') {
			for (const section of [
				this.alipanAccountSettings,
				this.commonSettings,
				this.filterSettings,
				this.cacheSettings,
				this.logSettings,
			])
				section.containerEl.empty()
			await this.quarkAccountSettings.display()
			return
		}
		this.quarkAccountSettings.containerEl.empty()
		await this.alipanAccountSettings.display()
		await this.commonSettings.display()
		await this.filterSettings.display()
		await this.cacheSettings.display()
		await this.logSettings.display()
	}

	async hide() {
		// No cleanup needed for Alipan settings
	}
}
