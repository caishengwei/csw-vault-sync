import globToRegExp from 'glob-to-regexp'
import { SyncError } from './types'

export const META_DIR = '.vault-sync'

export function validPath(path: string): string {
	if (
		!path ||
		path.startsWith('/') ||
		path.includes('\\') ||
		/[\u0000-\u001f\u007f]/.test(path)
	) {
		throw new SyncError('INVALID_PATH', '文件路径不合法')
	}
	const parts = path.split('/')
	if (
		parts.some(
			(part) => !part || part === '.' || part === '..' || /[:]/.test(part),
		)
	) {
		throw new SyncError('INVALID_PATH', '文件路径不合法')
	}
	return path
}

export function reservedPath(path: string): boolean {
	return path
		.split('/')
		.some(
			(part) =>
				['.git', '.obsidian', '.trash', META_DIR, '.DS_Store'].includes(
					part.toLowerCase(),
				) ||
				part.startsWith('.vault-sync-upload-') ||
				part.startsWith('.vault-sync-backup-'),
		)
}

export function exclusionMatcher(patterns: string[]) {
	let rules: RegExp[]
	try {
		rules = patterns.map((pattern) =>
			globToRegExp(pattern, { globstar: true, extended: true }),
		)
	} catch {
		throw new SyncError('INVALID_GLOB', '排除规则格式无效，请检查通配符规则')
	}
	return (path: string) =>
		reservedPath(path) ||
		rules.some((rule) => {
			const parts = path.split('/')
			return parts.some((_, i) => {
				const prefix = parts.slice(0, i + 1).join('/')
				return rule.test(prefix) || rule.test(prefix + '/')
			})
		})
}
