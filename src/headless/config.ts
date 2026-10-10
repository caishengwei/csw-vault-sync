import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { META_DIR } from './paths'
import { SyncConfig, SyncError } from './types'

import { validateConfig } from './configuration'
export { defaultConfig, validateConfig } from './configuration'

export function configPath(vault: string) {
	return resolve(vault, META_DIR, 'config.json')
}

export async function assertPrivateDirectory(directory: string) {
	try {
		await fs.mkdir(directory, { mode: 0o700 })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
	}
	const stat = await fs.lstat(directory)
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new SyncError('UNSAFE_PATH', '同步配置目录不能是符号链接')
}

export async function atomicWrite(path: string, content: string | Uint8Array) {
	const temporary = path + '.tmp-' + randomUUID()
	const handle = await fs.open(temporary, 'wx', 0o600)
	try {
		await handle.writeFile(content)
		await handle.sync()
		await handle.close()
		const target = await fs
			.lstat(path)
			.catch((error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') return undefined
				throw error
			})
		if (target?.isSymbolicLink() || target?.isDirectory())
			throw new SyncError('UNSAFE_PATH', '写入目标不能是符号链接或目录')
		await fs.rename(temporary, path)
	} finally {
		await handle.close().catch(() => {})
		await fs.unlink(temporary).catch(() => {})
	}
}

export async function readConfig(vault: string): Promise<SyncConfig> {
	const path = configPath(vault)
	await assertConfigLocation(vault)
	try {
		const stat = await fs.lstat(path)
		if (!stat.isFile() || stat.isSymbolicLink())
			throw new SyncError('UNSAFE_PATH', '同步配置文件必须是普通文件')
		return validateConfig(JSON.parse(await fs.readFile(path, 'utf8')))
	} catch (error) {
		if (error instanceof SyncError) throw error
		throw new SyncError(
			'CONFIG_MISSING',
			'请先在插件设置中配置夸克，或运行 vault-sync init',
		)
	}
}

async function assertConfigLocation(vault: string) {
	const meta = resolve(vault, META_DIR)
	const stat = await fs.lstat(meta).catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return undefined
		throw error
	})
	if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
		throw new SyncError('UNSAFE_PATH', '同步配置目录不能是符号链接')
}

export async function writeConfig(vault: string, config: SyncConfig) {
	validateConfig(config)
	await assertPrivateDirectory(resolve(vault, META_DIR))
	await atomicWrite(configPath(vault), JSON.stringify(config, null, 2) + '\n')
}

export function cookiePath(vault: string, config: SyncConfig) {
	return isAbsolute(config.cookieFile)
		? config.cookieFile
		: resolve(vault, config.cookieFile)
}

export async function readCookie(vault: string, config: SyncConfig) {
	try {
		const value = (await fs.readFile(cookiePath(vault, config), 'utf8')).trim()
		if (!value || /[\r\n\u0000]/.test(value) || !value.includes('='))
			throw new Error()
		return value
	} catch {
		throw new SyncError(
			'COOKIE_MISSING',
			'夸克 Cookie 文件不存在、不可读或格式无效',
		)
	}
}

export async function saveCookie(
	vault: string,
	config: SyncConfig,
	value: string,
) {
	if (!value || /[\r\n\u0000]/.test(value) || !value.includes('='))
		throw new SyncError('INVALID_COOKIE', 'Cookie 格式无效')
	const path = cookiePath(vault, config)
	if (dirname(path) === resolve(vault, META_DIR))
		await assertPrivateDirectory(dirname(path))
	await atomicWrite(path, value)
}
