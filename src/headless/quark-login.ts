import { randomUUID } from './common'
import { defaultConfig } from './configuration'
import { QuarkFileStore } from './quark'
import { checkAbort, HttpTransport, SyncError } from './types'

const CAS = 'https://uop.quark.cn/cas/ajax/'
const SUCCESS = 2000000
const COOKIE_NAMES = new Set(['__uid', '__kps', '__pus', '__puus'])
const AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

interface LoginResponse {
	status: number
	success?: boolean
	data?: {
		members?: { token?: string; service_ticket?: string }
		nickname?: string
	}
}

export type LoginStatus =
	| { state: 'waiting' }
	| { state: 'authenticated'; cookie: string; nickname?: string }

export class QuarkLoginClient {
	private token?: string
	private expiresAt = 0
	private cookies = new Map<string, string>()
	private exchanged = false

	constructor(private transport: HttpTransport) {}

	private async request(url: URL, signal?: AbortSignal) {
		checkAbort(signal)
		let response
		try {
			response = await this.transport({
				url: url.toString(),
				method: 'GET',
				signal,
				headers: {
					'User-Agent': AGENT,
					Referer: 'https://pan.quark.cn/',
					Origin: 'https://pan.quark.cn',
					Accept: 'application/json',
					...(this.cookies.size ? { Cookie: this.cookie() } : {}),
				},
			})
		} catch {
			checkAbort(signal)
			throw new SyncError('LOGIN_NETWORK', '夸克登录连接失败，请重试')
		}
		checkAbort(signal)
		if (response.status === 429)
			throw new SyncError('RATE_LIMITED', '夸克登录请求频繁，请稍后重试')
		if (response.status !== 200 || response.body.byteLength > 1024 * 1024)
			throw new SyncError('LOGIN_RESPONSE', '夸克登录接口响应异常，请重试')
		for (const match of (response.headers['set-cookie'] || '').matchAll(
			/(?:^|,\s*|\n\s*)(__[a-z]+)=([^;,\r\n]*)/g,
		)) {
			if (COOKIE_NAMES.has(match[1]) && match[2])
				this.cookies.set(match[1], match[2])
		}
		try {
			const body = JSON.parse(new TextDecoder().decode(response.body))
			if (!body || typeof body !== 'object' || Array.isArray(body))
				throw new Error()
			return body as LoginResponse
		} catch {
			throw new SyncError('LOGIN_RESPONSE', '夸克登录接口响应异常，请重试')
		}
	}

	private cookie() {
		return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ')
	}

	private casUrl(method: string) {
		const url = new URL(CAS + method)
		url.searchParams.set('client_id', '532')
		url.searchParams.set('v', '1.2')
		url.searchParams.set('request_id', randomUUID())
		return url
	}

	async create(signal?: AbortSignal) {
		this.dispose()
		const body = await this.request(
			this.casUrl('getTokenForQrcodeLogin'),
			signal,
		)
		const token = body.data?.members?.token
		if (
			body.status !== SUCCESS ||
			typeof token !== 'string' ||
			!token ||
			token.length > 1024 ||
			/[\r\n\u0000]/.test(token)
		)
			throw new SyncError('LOGIN_TOKEN', '无法获取夸克登录二维码，请重试')
		this.token = token
		this.expiresAt = Date.now() + 5 * 60 * 1000
		this.exchanged = false
		const url = new URL('https://su.quark.cn/4_eMHBJ')
		for (const [key, value] of Object.entries({
			token,
			client_id: '532',
			ssb: 'weblogin',
			uc_param_str: '',
			uc_biz_str: 'S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0',
		}))
			url.searchParams.set(key, value)
		return { url: url.toString(), expiresAt: this.expiresAt }
	}

	async poll(signal?: AbortSignal): Promise<LoginStatus> {
		checkAbort(signal)
		if (!this.token || this.exchanged)
			throw new SyncError('LOGIN_SESSION', '请刷新二维码后重新登录')
		if (Date.now() >= this.expiresAt)
			throw new SyncError('LOGIN_EXPIRED', '二维码已过期，请刷新二维码')
		const url = this.casUrl('getServiceTicketByQrcodeToken')
		url.searchParams.set('token', this.token)
		const body = await this.request(url, signal)
		if (body.status === 50004001) return { state: 'waiting' }
		if (body.status === 50004002)
			throw new SyncError('LOGIN_EXPIRED', '二维码已过期，请刷新二维码')
		if (body.status === 50004004)
			throw new SyncError('LOGIN_DENIED', '手机端已取消登录，可刷新二维码重试')
		const ticket = body.data?.members?.service_ticket
		if (body.status !== SUCCESS || typeof ticket !== 'string' || !ticket)
			throw new SyncError('LOGIN_FAILED', '夸克登录未成功，请刷新二维码重试')
		this.exchanged = true
		this.token = undefined
		const accountUrl = new URL('https://pan.quark.cn/account/info')
		accountUrl.searchParams.set('st', ticket)
		accountUrl.searchParams.set('lw', 'scan')
		const account = await this.request(accountUrl, signal)
		if (
			!account.success ||
			!account.data ||
			!this.cookies.has('__uid') ||
			(!this.cookies.has('__kps') && !this.cookies.has('__pus'))
		)
			throw new SyncError('LOGIN_COOKIE', '登录凭据获取失败，请重新扫码登录')
		const store = new QuarkFileStore(
			this.cookie(),
			'0',
			this.transport,
			defaultConfig.maxFileSize,
		)
		try {
			await store.testConnection(signal)
		} catch {
			checkAbort(signal)
			throw new SyncError('LOGIN_VERIFY', '登录后网盘访问验证失败，请重新登录')
		}
		checkAbort(signal)
		return {
			state: 'authenticated',
			cookie: store.cookie,
			nickname:
				typeof account.data.nickname === 'string'
					? account.data.nickname.slice(0, 100)
					: undefined,
		}
	}

	dispose() {
		this.token = undefined
		this.expiresAt = 0
		this.cookies.clear()
	}
}
