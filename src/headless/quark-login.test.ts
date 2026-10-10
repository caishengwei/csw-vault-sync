import { afterEach, describe, expect, it, vi } from 'vitest'
import { QuarkLoginClient } from './quark-login'
import { HttpRequest, HttpTransport } from './types'
import { MockQuark } from './test-support'

function loginServer() {
	const drive = new MockQuark()
	const requests: HttpRequest[] = []
	const options = {
		pollStatus: 50004001,
		accountSuccess: true,
		cookie:
			'__uid=test-user; Path=/, __kps=synthetic-cookie; Path=/; HttpOnly, __pus=synthetic-pus; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/, unrelated=excluded; Path=/',
	}
	const transport: HttpTransport = async (request) => {
		requests.push(request)
		const url = new URL(request.url)
		const json = (value: unknown, headers = {}) => ({
			status: 200,
			headers,
			body: new TextEncoder().encode(JSON.stringify(value)),
		})
		if (url.pathname.endsWith('getTokenForQrcodeLogin'))
			return json({ status: 2000000, data: { members: { token: 'qr-token' } } })
		if (url.pathname.endsWith('getServiceTicketByQrcodeToken'))
			return json({
				status: options.pollStatus,
				data:
					options.pollStatus === 2000000
						? { members: { service_ticket: 'synthetic-ticket' } }
						: undefined,
			})
		if (url.pathname === '/account/info')
			return json(
				{ success: options.accountSuccess, data: { nickname: 'Test User' } },
				{ 'set-cookie': options.cookie },
			)
		return drive.transport(request)
	}
	return { requests, options, transport }
}

afterEach(() => vi.useRealTimers())

describe('Quark QR login', () => {
	it('creates the official QR URL and waits without exchanging credentials', async () => {
		const server = loginServer()
		const client = new QuarkLoginClient(server.transport)
		const session = await client.create()
		const qr = new URL(session.url)
		expect(qr.origin + qr.pathname).toBe('https://su.quark.cn/4_eMHBJ')
		expect(qr.searchParams.get('token')).toBe('qr-token')
		expect(qr.searchParams.get('client_id')).toBe('532')
		expect(new URL(server.requests[0].url).searchParams.get('v')).toBe('1.2')
		expect(await client.poll()).toEqual({ state: 'waiting' })
		expect(server.requests).toHaveLength(2)
		expect(server.requests.every((request) => !request.headers?.Cookie)).toBe(
			true,
		)
	})

	it('exchanges the confirmed ticket once and verifies complete cookies before returning them', async () => {
		const server = loginServer()
		server.options.pollStatus = 2000000
		const client = new QuarkLoginClient(server.transport)
		await client.create()
		const result = await client.poll()
		expect(result.state).toBe('authenticated')
		if (result.state !== 'authenticated') throw new Error()
		expect(result.nickname).toBe('Test User')
		expect(result.cookie).toContain('__uid=test-user')
		expect(result.cookie).toContain('__kps=synthetic-cookie')
		expect(result.cookie).toContain('__pus=synthetic-pus')
		expect(result.cookie).not.toContain('unrelated')
		const exchange = server.requests.find((request) =>
			request.url.includes('/account/info'),
		)!
		expect(new URL(exchange.url).searchParams.get('st')).toBe(
			'synthetic-ticket',
		)
		expect(new URL(exchange.url).searchParams.get('lw')).toBe('scan')
		expect(server.requests.at(-1)!.url).toContain('/file/sort?')
		expect(server.requests.every((request) => request.method === 'GET')).toBe(
			true,
		)
		await expect(client.poll()).rejects.toMatchObject({ code: 'LOGIN_SESSION' })
	})

	it.each([
		[50004002, 'LOGIN_EXPIRED'],
		[50004003, 'LOGIN_FAILED'],
		[50004004, 'LOGIN_DENIED'],
	])(
		'stops for QR failure status %s without exchanging tickets',
		async (status, code) => {
			const server = loginServer()
			server.options.pollStatus = status as number
			const client = new QuarkLoginClient(server.transport)
			await client.create()
			await expect(client.poll()).rejects.toMatchObject({ code })
			expect(server.requests).toHaveLength(2)
		},
	)

	it('rejects expired, disposed and cancelled sessions without any further requests', async () => {
		vi.useFakeTimers()
		const server = loginServer()
		const client = new QuarkLoginClient(server.transport)
		const session = await client.create()
		vi.setSystemTime(session.expiresAt)
		await expect(client.poll()).rejects.toMatchObject({ code: 'LOGIN_EXPIRED' })
		client.dispose()
		await expect(client.poll()).rejects.toMatchObject({ code: 'LOGIN_SESSION' })
		const controller = new AbortController()
		controller.abort()
		await expect(client.create(controller.signal)).rejects.toMatchObject({
			code: 'CANCELLED',
		})
		expect(server.requests).toHaveLength(1)
	})

	it('ignores a confirmed response arriving after cancellation', async () => {
		const server = loginServer()
		const controller = new AbortController()
		const client = new QuarkLoginClient(async (request) => {
			if (request.url.includes('getServiceTicketByQrcodeToken'))
				controller.abort()
			return server.transport(request)
		})
		server.options.pollStatus = 2000000
		await client.create()
		await expect(client.poll(controller.signal)).rejects.toMatchObject({
			code: 'CANCELLED',
		})
		expect(server.requests).toHaveLength(2)
	})

	it('does not return credentials when exchange or drive verification fails', async () => {
		const server = loginServer()
		server.options.pollStatus = 2000000
		server.options.accountSuccess = false
		const client = new QuarkLoginClient(server.transport)
		await client.create()
		await expect(client.poll()).rejects.toMatchObject({ code: 'LOGIN_COOKIE' })
		server.options.accountSuccess = true
		server.options.cookie = 'unrelated=excluded; Path=/'
		await client.create()
		await expect(client.poll()).rejects.toMatchObject({ code: 'LOGIN_COOKIE' })
	})

	it('reports safe errors without revealing QR tokens, tickets or raw responses', async () => {
		const client = new QuarkLoginClient(async () => {
			throw new Error('qr-token; synthetic-ticket; private response')
		})
		await expect(client.create()).rejects.toMatchObject({
			code: 'LOGIN_NETWORK',
			message: '夸克登录连接失败，请重试',
		})
		const malformed = new QuarkLoginClient(async () => ({
			status: 200,
			headers: {},
			body: new TextEncoder().encode('synthetic-ticket'),
		}))
		await expect(malformed.create()).rejects.toMatchObject({
			code: 'LOGIN_RESPONSE',
			message: '夸克登录接口响应异常，请重试',
		})
	})
})
