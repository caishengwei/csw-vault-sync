import { encode, fromBase64, toBase64 } from './common'
import { defaultConfig, validateConfig, validateCookie } from './configuration'
import { SyncConfig, SyncError } from './types'

const PREFIX = 'VSA1.'
const ITERATIONS = 150000

function cryptoApi() {
	if (!globalThis.crypto?.subtle)
		throw new SyncError(
			'CRYPTO_UNAVAILABLE',
			'当前设备不支持加密授权，请更新 Obsidian',
		)
	return globalThis.crypto
}

async function key(password: string, salt: Uint8Array) {
	if (password.length < 8 || password.length > 1024)
		throw new SyncError('AUTH_PASSWORD', '授权密码至少需要 8 个字符')
	const api = cryptoApi()
	const source = await api.subtle.importKey(
		'raw',
		encode(password),
		'PBKDF2',
		false,
		['deriveKey'],
	)
	return api.subtle.deriveKey(
		{
			name: 'PBKDF2',
			salt: salt as BufferSource,
			iterations: ITERATIONS,
			hash: 'SHA-256',
		},
		source,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	)
}

export async function exportAuthorization(
	config: SyncConfig,
	cookie: string,
	password: string,
) {
	validateConfig(config)
	validateCookie(cookie)
	if (cookie.length > 8192)
		throw new SyncError('AUTH_SIZE', '登录凭据超过授权码大小上限')
	const api = cryptoApi()
	const salt = api.getRandomValues(new Uint8Array(16))
	const iv = api.getRandomValues(new Uint8Array(12))
	const payload = encode(
		JSON.stringify({
			version: 1,
			expiresAt: Date.now() + 24 * 60 * 60 * 1000,
			config: {
				...config,
				cookieFile: defaultConfig.cookieFile,
				allowDeletes: false,
			},
			cookie,
		}),
	)
	const encrypted = await api.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		await key(password, salt),
		payload,
	)
	return (
		PREFIX +
		toBase64(
			encode(
				JSON.stringify({
					version: 1,
					salt: toBase64(salt),
					iv: toBase64(iv),
					data: toBase64(new Uint8Array(encrypted)),
				}),
			),
		)
	)
}

export async function importAuthorization(value: string, password: string) {
	if (!value.startsWith(PREFIX) || value.length > 32768)
		throw new SyncError('AUTH_FORMAT', '授权码格式无效，请从电脑插件重新导出')
	try {
		const envelope = JSON.parse(
			new TextDecoder().decode(fromBase64(value.slice(PREFIX.length))),
		)
		if (
			envelope.version !== 1 ||
			typeof envelope.salt !== 'string' ||
			typeof envelope.iv !== 'string' ||
			typeof envelope.data !== 'string'
		)
			throw new Error()
		const salt = fromBase64(envelope.salt)
		const iv = fromBase64(envelope.iv)
		const data = fromBase64(envelope.data)
		if (
			salt.length !== 16 ||
			iv.length !== 12 ||
			data.length < 16 ||
			data.length > 24000
		)
			throw new Error()
		const decrypted = await cryptoApi().subtle.decrypt(
			{ name: 'AES-GCM', iv: iv as BufferSource },
			await key(password, salt),
			data as BufferSource,
		)
		const payload = JSON.parse(
			new TextDecoder('utf-8', { fatal: true }).decode(decrypted),
		)
		if (payload.version !== 1 || !Number.isSafeInteger(payload.expiresAt))
			throw new Error()
		if (Date.now() > payload.expiresAt)
			throw new SyncError(
				'AUTH_EXPIRED',
				'授权码已超过 24 小时，请从电脑重新导出',
			)
		const config = validateConfig({
			...payload.config,
			cookieFile: defaultConfig.cookieFile,
			allowDeletes: false,
		})
		if (typeof payload.cookie !== 'string' || payload.cookie.length > 8192)
			throw new Error()
		return { config, cookie: validateCookie(payload.cookie) }
	} catch (error) {
		if (
			error instanceof SyncError &&
			['AUTH_EXPIRED', 'AUTH_PASSWORD', 'CRYPTO_UNAVAILABLE'].includes(
				error.code,
			)
		)
			throw error
		throw new SyncError(
			'AUTH_DECRYPT',
			'授权密码错误或授权码损坏，请检查后重试',
		)
	}
}
