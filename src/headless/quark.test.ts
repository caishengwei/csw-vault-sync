import { describe, expect, it } from 'vitest'
import { QuarkFileStore } from './quark'
import { MockQuark } from './test-support'
import { HttpTransport } from './types'

describe('Quark protocol boundaries', () => {
	it.each(['http://pds.quark.cn', 'http://oss-cn-test.aliyuncs.com'])(
		'uploads to trusted endpoint %s with the required OSS signature',
		async (endpoint) => {
			const server = new MockQuark()
			server.uploadEndpoint = endpoint
			const store = new QuarkFileStore(
				'__uid=test',
				'root',
				server.transport,
				1024,
			)
			await store.write(
				'note.md',
				new TextEncoder().encode('verified'),
				undefined,
			)
			expect(new TextDecoder().decode(server.get('note.md')!.bytes)).toBe(
				'verified',
			)
			const put = server.requests.find((request) => request.method === 'PUT')!
			expect(put.headers?.Cookie).toBeUndefined()
			const signed = server.requests
				.filter((request) => request.url.includes('/file/upload/auth?'))
				.map((request) => JSON.parse(request.body as string).auth_meta)
			expect(signed[0]).toMatch(/^PUT\n\napplication\/octet-stream\n/)
		},
	)

	it('rejects an untrusted upload host before sending a signed upload request', async () => {
		const server = new MockQuark()
		server.uploadEndpoint = 'http://foreign.example'
		const store = new QuarkFileStore(
			'__uid=test',
			'root',
			server.transport,
			1024,
		)
		await expect(
			store.write('note.md', new TextEncoder().encode('note'), undefined),
		).rejects.toMatchObject({ code: 'QUARK_UPLOAD' })
		expect(
			server.requests.some((request) =>
				new URL(request.url).hostname.includes('foreign.example'),
			),
		).toBe(false)
	})
	it('collects all pages rather than treating a partial listing as deletions', async () => {
		const server = new MockQuark()
		for (let i = 0; i < 205; i++) server.add(`note-${i}.md`, 'test')
		const store = new QuarkFileStore(
			'__uid=test',
			'root',
			server.transport,
			1024,
		)
		expect(await store.list()).toHaveLength(205)
		expect(
			server.requests.filter((request) => request.url.includes('/file/sort?')),
		).toHaveLength(3)
	})

	it('restarts a temporarily inconsistent directory listing after upload without repeating the upload', async () => {
		const server = new MockQuark()
		let inconsistent = false
		const store = new QuarkFileStore(
			'__uid=test',
			'root',
			async (request) => {
				const response = await server.transport(request)
				if (
					request.url.includes('/file/sort?') &&
					!inconsistent &&
					[...server.files.values()].some((file) =>
						file.file_name.startsWith('.vault-sync-upload-'),
					)
				) {
					inconsistent = true
					const payload = JSON.parse(new TextDecoder().decode(response.body))
					payload.metadata._total++
					response.body = new TextEncoder().encode(JSON.stringify(payload))
				}
				return response
			},
			1024,
		)
		await store.write('note.md', new TextEncoder().encode('test'), undefined)
		expect(inconsistent).toBe(true)
		expect(server.get('note.md')?.size).toBe(4)
		expect(
			server.requests.filter((request) => request.url.includes('/upload/pre?')),
		).toHaveLength(1)
	})

	it('cancels an inconsistent listing before retrying', async () => {
		const controller = new AbortController()
		let requests = 0
		const store = new QuarkFileStore(
			'__uid=test',
			'root',
			async () => {
				requests++
				setTimeout(() => controller.abort(), 0)
				return {
					status: 200,
					headers: {},
					body: new TextEncoder().encode(
						JSON.stringify({
							status: 200,
							code: 0,
							data: { list: [] },
							metadata: { _total: 1 },
						}),
					),
				}
			},
			1024,
		)
		await expect(store.list(controller.signal)).rejects.toMatchObject({
			code: 'CANCELLED',
		})
		expect(requests).toBe(1)
	})

	it('rejects incomplete pagination and malformed metadata', async () => {
		const response = (list: unknown[], total: number) => ({
			status: 200,
			headers: {},
			body: new TextEncoder().encode(
				JSON.stringify({
					status: 200,
					code: 0,
					data: { list },
					metadata: { _total: total },
				}),
			),
		})
		const incomplete = new QuarkFileStore(
			'__uid=test',
			'root',
			async () => response([], 10),
			1024,
		)
		await expect(incomplete.list()).rejects.toMatchObject({
			code: 'QUARK_PAGINATION',
		})
		const malformed = new QuarkFileStore(
			'__uid=test',
			'root',
			async () =>
				response([{ fid: 'f', file_name: 'note.md', file: true, size: 1 }], 1),
			1024,
		)
		await expect(malformed.list()).rejects.toMatchObject({
			code: 'QUARK_SCHEMA',
		})
	})

	it('reports expired credentials without repeating cookies or API response details', async () => {
		const transport: HttpTransport = async () => ({
			status: 401,
			headers: {},
			body: new TextEncoder().encode(
				JSON.stringify({
					status: 401,
					code: 32003,
					message: 'login failed; __uid=secret-example',
				}),
			),
		})
		const store = new QuarkFileStore(
			'__uid=secret-example',
			'root',
			transport,
			1024,
		)
		await expect(store.testConnection()).rejects.toMatchObject({
			code: 'AUTH_REQUIRED',
		})
		try {
			await store.testConnection()
		} catch (error) {
			expect(String(error)).not.toContain('secret-example')
		}
	})

	it('updates rotating cookies without changing the stable account namespace', async () => {
		const server = new MockQuark()
		const store = new QuarkFileStore(
			'__uid=test; __puus=old',
			'root',
			async (request) => {
				const response = await server.transport(request)
				response.headers['set-cookie'] = '__puus=new; Path=/; Secure'
				return response
			},
			1024,
		)
		const before = store.mountIdentity
		await store.testConnection()
		expect(store.cookie).toContain('__puus=new')
		expect(store.mountIdentity).toBe(before)
	})

	it('rejects foreign download URLs before forwarding any credentials', async () => {
		const server = new MockQuark()
		server.add('note.md', 'test')
		const store = new QuarkFileStore(
			'__uid=test',
			'root',
			async (request) => {
				if (request.url.includes('/file/download?'))
					return {
						status: 200,
						headers: {},
						body: new TextEncoder().encode(
							JSON.stringify({
								status: 200,
								code: 0,
								data: [{ download_url: 'https://foreign.example/file' }],
							}),
						),
					}
				return server.transport(request)
			},
			1024,
		)
		await expect(store.read('note.md')).rejects.toMatchObject({
			code: 'QUARK_URL',
		})
		expect(
			server.requests.some((request) =>
				request.url.includes('foreign.example'),
			),
		).toBe(false)
	})

	it('waits for eventual listing visibility after upload without retrying mutations', async () => {
		const server = new MockQuark()
		let hidden = 0
		const store = new QuarkFileStore(
			'__uid=test',
			'root',
			async (request) => {
				const response = await server.transport(request)
				if (
					request.url.includes('/file/sort?') &&
					[...server.files.values()].some((file) =>
						file.file_name.startsWith('.vault-sync-upload-'),
					) &&
					hidden++ < 2
				) {
					const payload = JSON.parse(new TextDecoder().decode(response.body))
					payload.data.list = []
					payload.metadata._total = 0
					response.body = new TextEncoder().encode(JSON.stringify(payload))
				}
				return response
			},
			1024,
		)
		await store.write('note.md', new TextEncoder().encode('test'), undefined)
		expect(server.get('note.md')?.size).toBe(4)
		expect(
			server.requests.filter((request) => request.url.includes('/upload/pre?')),
		).toHaveLength(1)
	})
})
