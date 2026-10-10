import { exclusionMatcher, META_DIR } from './paths'
import { SyncConfig, SyncError } from './types'

export const defaultConfig: SyncConfig = {
	version: 1,
	provider: 'quark',
	rootFolderId: '',
	cookieFile: `${META_DIR}/quark-cookie.txt`,
	maxFileSize: 30 * 1024 * 1024,
	exclude: [],
	allowDeletes: false,
	mergeText: true,
}

export function validateConfig(value: unknown): SyncConfig {
	const config = value as SyncConfig
	if (
		!config ||
		config.version !== 1 ||
		config.provider !== 'quark' ||
		typeof config.rootFolderId !== 'string' ||
		!/^[a-zA-Z0-9_-]+$/.test(config.rootFolderId) ||
		typeof config.cookieFile !== 'string' ||
		!config.cookieFile.trim() ||
		!Number.isSafeInteger(config.maxFileSize) ||
		config.maxFileSize < 1 ||
		config.maxFileSize > 512 * 1024 * 1024 ||
		!Array.isArray(config.exclude) ||
		config.exclude.some((s) => typeof s !== 'string') ||
		typeof config.allowDeletes !== 'boolean' ||
		typeof config.mergeText !== 'boolean'
	)
		throw new SyncError(
			'INVALID_CONFIG',
			'同步配置不完整或不合法，请设置夸克目录 ID 和 Cookie 文件',
		)
	try {
		exclusionMatcher(config.exclude)
	} catch {
		throw new SyncError('INVALID_CONFIG', '排除规则格式无效，请检查通配符规则')
	}
	return { ...defaultConfig, ...config, exclude: [...config.exclude] }
}

export function validateCookie(value: string) {
	if (!value || /[\r\n\u0000]/.test(value) || !value.includes('='))
		throw new SyncError('INVALID_COOKIE', 'Cookie 格式无效')
	return value
}
