import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { MockQuark } from './test-support'
import { acquireLock } from './state'
import { defaultConfig, saveCookie } from './config'
import { webcrypto } from 'node:crypto'
import { mobileTestApp, TestFile } from '../mobile/test-support'

describe('compiled desktop plugin', () => {
	let directory: string | undefined
	let desktopAuthorization: string | undefined
	afterEach(async () => {
		if (directory) await fs.rm(directory, { recursive: true, force: true })
	})

	it.each(['desktop', 'mobile'])(
		'loads on %s, renders settings and syncs through the native HTTP adapter',
		async (platform) => {
			directory = await fs.mkdtemp(join(tmpdir(), 'vault-sync-plugin-'))
			const root = directory
			const quark = new MockQuark()
			const settings: Array<{
				name: string
				input?: {
					change?: (value: string) => void
					element?: { value: string }
				}
				buttons: Array<{ label: string; click?: () => Promise<void> }>
			}> = []
			const nodeRequire = createRequire(resolve('package.json'))
			const loginImages: Array<{ src?: string; alt?: string }> = []
			const modalMessages: string[] = []
			const notices: string[] = []
			const modals: Array<{ close: () => void }> = []
			class Element {
				classList = { add() {}, remove() {} }
				createDiv() {
					return new Element()
				}
				createEl(
					tag: string,
					options?: { attr?: { src?: string; alt?: string } },
				) {
					if (tag === 'img') loginImages.push(options?.attr || {})
					return new Element()
				}
				empty() {}
				setText(text: string) {
					modalMessages.push(text)
				}
				setAttr() {}
				addClass() {}
				removeClass() {}
				removeAttribute() {}
			}
			class Setting {
				row = {
					name: '',
					buttons: [] as Array<{ label: string; click?: () => Promise<void> }>,
					input: undefined as
						| { change?: (value: string) => void; element?: { value: string } }
						| undefined,
				}
				constructor() {
					settings.push(this.row)
				}
				setName(name: string) {
					this.row.name = name
					return this
				}
				setDesc() {
					return this
				}
				setHeading() {
					return this
				}
				addDropdown(callback: (control: unknown) => void) {
					const control = {
						addOption: () => control,
						setValue: () => control,
						onChange: () => control,
					}
					callback(control)
					return this
				}
				addText(callback: (control: unknown) => void) {
					const input = {
						change: undefined as ((value: string) => void) | undefined,
						element: { value: '', type: '', addEventListener() {} },
					}
					this.row.input = input
					const control = {
						inputEl: input.element,
						setValue: () => control,
						onChange: (change: (value: string) => void) => {
							input.change = change
							return control
						},
					}
					callback(control)
					return this
				}
				addTextArea(callback: (control: unknown) => void) {
					return this.addText(callback)
				}
				addToggle(callback: (control: unknown) => void) {
					const control = { setValue: () => control, onChange: () => control }
					callback(control)
					return this
				}
				addButton(callback: (control: unknown) => void) {
					const button = {
						label: '',
						click: undefined as (() => Promise<void>) | undefined,
					}
					this.row.buttons.push(button)
					const control = {
						setButtonText: (label: string) => {
							button.label = label
							return control
						},
						setCta: () => control,
						setDisabled: () => control,
						onClick: (click: () => Promise<void>) => {
							button.click = click
							return control
						},
					}
					callback(control)
					return this
				}
			}
			class Plugin {
				app = mobileTestApp(root).app
				constructor() {
					if (platform === 'desktop')
						Object.assign(this.app.vault.adapter, { getBasePath: () => root })
				}
				manifest = { id: 'csw-vault-sync', name: 'Vault Sync' }
				tabs: Array<{ display: () => Promise<void> }> = []
				commands: unknown[] = []
				addCommand(command: unknown) {
					this.commands.push(command)
				}
				addRibbonIcon() {
					return new Element()
				}
				addStatusBarItem() {
					return new Element()
				}
				registerEvent() {}
				registerObsidianProtocolHandler() {}
				addSettingTab(tab: { display: () => Promise<void> }) {
					this.tabs.push(tab)
				}
				async loadData() {
					return undefined
				}
				async saveData() {}
			}
			class PluginSettingTab {
				containerEl = new Element()
				constructor(public app: Plugin['app']) {}
			}
			class Modal {
				contentEl = new Element()
				constructor() {
					modals.push(this)
				}
				onOpen() {}
				onClose() {}
				open() {
					this.onOpen()
				}
				close() {
					this.onClose()
				}
			}
			const obsidian = {
				Plugin,
				PluginSettingTab,
				Modal,
				Setting,
				Notice: class {
					constructor(message: string) {
						notices.push(message)
					}
				},
				Platform: {
					isDesktopApp: platform === 'desktop',
					isMacOS: platform === 'desktop',
					isAndroidApp: platform === 'mobile',
					isMobileApp: platform === 'mobile',
				},
				TFile: TestFile,
				TFolder: class {},
				TAbstractFile: class {},
				Component: class {},
				FileSystemAdapter: class {},
				normalizePath: (value: string) => value,
				requireApiVersion: () => true,
				moment: () => ({ format: () => '' }),
				apiVersion: '1.12.3',
				requestUrl: async (request: {
					url: string
					method: string
					headers?: Record<string, string>
					body?: string | ArrayBuffer
				}) => {
					if (request.url.includes('getTokenForQrcodeLogin')) {
						const bytes = new TextEncoder().encode(
							JSON.stringify({
								status: 2000000,
								data: { members: { token: 'synthetic-token' } },
							}),
						)
						return {
							status: 200,
							headers: {
								'Set-Cookie': [
									'session=synthetic; Path=/',
									'unused=ignored; Path=/',
								],
							},
							arrayBuffer: bytes.buffer,
						}
					}
					const result = await quark.transport({
						...request,
						body:
							typeof request.body === 'string'
								? request.body
								: request.body
									? new Uint8Array(request.body)
									: undefined,
					})
					return {
						status: result.status,
						headers: result.headers,
						arrayBuffer: result.body.buffer.slice(
							result.body.byteOffset,
							result.body.byteOffset + result.body.byteLength,
						),
						text: new TextDecoder().decode(result.body),
					}
				},
			}
			const module = {
				exports: {} as {
					default: new () => Plugin & {
						onload: () => Promise<void>
						onunload: () => Promise<void>
						settings: {
							provider: string
							alipan?: unknown
							filterRules: { exclusionRules: Array<{ expr: string }> }
						}
						isAccountConfigured: () => boolean
						createRemoteStorage?: () => Promise<undefined>
						syncExecutorService: {
							executeSync: (options: { mode: string }) => Promise<boolean>
						}
						quarkSyncService: { execute: (manual: boolean) => Promise<boolean> }
					}
				},
			}
			const document = { addEventListener() {}, removeEventListener() {} }
			runInNewContext(
				await fs.readFile('dist/main.js', 'utf8'),
				{
					module,
					exports: module.exports,
					require: (name: string) => {
						if (name === 'obsidian') return obsidian
						if (platform === 'mobile')
							throw new Error('Node API forbidden on mobile: ' + name)
						return nodeRequire(name)
					},
					...(platform === 'desktop' ? { Buffer, process } : {}),
					crypto: webcrypto,
					console,
					TextEncoder,
					TextDecoder,
					URL,
					AbortController,
					AbortSignal,
					setTimeout,
					clearTimeout,
					setInterval,
					clearInterval,
					document,
					window: {
						document,
						setTimeout,
						clearTimeout,
						setInterval,
						clearInterval,
					},
					navigator: { language: 'zh-CN' },
				},
				{ filename: 'dist/main.js' },
			)
			const plugin = new module.exports.default()
			try {
				await plugin.onload()
				expect(plugin.settings.provider).toBe('quark')
				expect(plugin.isAccountConfigured()).toBe(false)
				await plugin.tabs[0].display()
				expect(
					settings
						.flatMap((row) => row.buttons)
						.some((button) => button.label === '扫码登录'),
				).toBe(true)
				await settings
					.flatMap((row) => row.buttons)
					.find((button) => button.label === '扫码登录')!.click!()
				await new Promise((resolve) => setTimeout(resolve, 20))
				expect(loginImages).toHaveLength(1)
				expect(loginImages[0].src).toMatch(/^data:image\/gif;base64,/)
				expect(loginImages[0].alt).toBe('夸克登录二维码')
				expect(modalMessages.at(-1)).toContain('等待扫码并确认登录')
				modals.at(-1)!.close()
				expect(await fs.readdir(root)).toEqual([])
				await saveCookie(
					root,
					defaultConfig,
					'__uid=test-user; __kps=synthetic-cookie',
				)
				await settings
					.flatMap((row) => row.buttons)
					.find((button) => button.label === '测试连接')!.click!()
				expect(notices.at(-1)).toBe(
					'夸克登录有效，请填写同步目录 ID 并保存配置',
				)
				await expect(
					fs.stat(join(root, '.vault-sync/config.json')),
				).rejects.toMatchObject({ code: 'ENOENT' })
				expect(await fs.readdir(join(root, '.vault-sync'))).not.toContain(
					'lock',
				)
				settings.find((row) => row.name === '同步目录 ID')!.input!.change!(
					'root',
				)
				settings.find((row) => row.name === '更新 Cookie')!.input!.change!(
					'__uid=test-user; __kps=synthetic-cookie',
				)
				const save = settings
					.flatMap((row) => row.buttons)
					.find((button) => button.label === '保存夸克配置')!
				await save.click!()
				expect(plugin.isAccountConfigured()).toBe(true)
				expect(
					JSON.parse(
						await fs.readFile(join(root, '.vault-sync/config.json'), 'utf8'),
					).rootFolderId,
				).toBe('root')
				const button = (label: string) =>
					settings
						.flatMap((row) => row.buttons)
						.filter((item) => item.label === label)
						.at(-1)!
				const input = (name: string) =>
					settings.filter((row) => row.name === name).at(-1)!.input!
				await button('导出到手机').click!()
				input('授权密码').change!('synthetic-password')
				await button('生成授权码').click!()
				const authorization = input('加密授权码').element!.value
				expect(authorization).toMatch(/^VSA1\./)
				expect(authorization).not.toContain('synthetic-cookie')
				if (platform === 'desktop') desktopAuthorization = authorization
				modals.at(-1)!.close()
				await button('导入电脑授权').click!()
				input('授权密码').change!('synthetic-password')
				input('加密授权码').change!(
					platform === 'mobile' ? desktopAuthorization! : authorization,
				)
				await button('导入授权').click!()
				expect(notices.at(-1)).toBe('夸克账号和同步目录已导入，可先预览同步')
				expect(
					await fs.readFile(join(root, '.vault-sync/quark-cookie.txt'), 'utf8'),
				).toContain('synthetic-cookie')
				expect(
					JSON.parse(
						await fs.readFile(join(root, '.vault-sync/config.json'), 'utf8'),
					).allowDeletes,
				).toBe(false)
				await fs.writeFile(join(root, 'plugin.md'), 'from desktop plugin')
				expect(await plugin.quarkSyncService.execute(true)).toBe(true)
				expect(new TextDecoder().decode(quark.get('plugin.md')!.bytes)).toBe(
					'from desktop plugin',
				)
				expect(await fs.readdir(join(root, '.vault-sync'))).not.toContain(
					'lock',
				)
				const config = JSON.parse(
					await fs.readFile(join(root, '.vault-sync/config.json'), 'utf8'),
				)
				config.cookieFile = 'credentials.txt'
				await fs.writeFile(
					join(root, '.vault-sync/config.json'),
					JSON.stringify(config),
				)
				await fs.writeFile(
					join(root, 'credentials.txt'),
					'__uid=test-user; __kps=synthetic-cookie',
				)
				plugin.settings.provider = 'alipan'
				plugin.settings.alipan = {
					clientId: 'synthetic-client',
					refreshToken: 'synthetic-refresh',
					driveId: 'synthetic-drive',
				}
				let factoryCalls = 0
				plugin.createRemoteStorage = async () => {
					factoryCalls++
					return undefined
				}
				const release = await acquireLock(root)
				expect(
					await plugin.syncExecutorService.executeSync({ mode: 'manual_sync' }),
				).toBe(false)
				expect(factoryCalls).toBe(0)
				await release()
				expect(
					await plugin.syncExecutorService.executeSync({ mode: 'manual_sync' }),
				).toBe(false)
				expect(factoryCalls).toBe(1)
				expect(
					plugin.settings.filterRules.exclusionRules.map((rule) => rule.expr),
				).toContain('.vault-sync')
				expect(
					plugin.settings.filterRules.exclusionRules.map((rule) => rule.expr),
				).toContain('credentials.txt')
				await new Promise((resolve) => setTimeout(resolve, 110))
			} finally {
				await plugin.onunload()
			}
		},
	)
})
