import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportAuthorization, importAuthorization } from './authorization'
import { defaultConfig } from './configuration'
import { createHash } from 'node:crypto'
import { encode, sha256, md5Hex, sha1Hex, md5Base64 } from './common'

afterEach(() => vi.useRealTimers())

describe('portable hashes and encrypted device authorization', () => {
	it('matches desktop hash values for binary content and upload signatures', () => {
		for (const bytes of [
			new Uint8Array(),
			encode('中文\n'),
			new Uint8Array([0, 255, 127, 34]),
		]) {
			expect(sha256(bytes)).toBe(
				createHash('sha256').update(bytes).digest('hex'),
			)
			expect(md5Hex(bytes)).toBe(createHash('md5').update(bytes).digest('hex'))
			expect(sha1Hex(bytes)).toBe(
				createHash('sha1').update(bytes).digest('hex'),
			)
			expect(md5Base64(bytes)).toBe(
				createHash('md5').update(bytes).digest('base64'),
			)
		}
	})

	it('round-trips credentials and directory while removing desktop paths and disabling deletes', async () => {
		const config = {
			...defaultConfig,
			rootFolderId: 'test-root',
			cookieFile: '/desktop/secret.txt',
			exclude: ['ignored/**'],
			allowDeletes: true,
		}
		const cookie = '__uid=synthetic-user; __kps=synthetic-secret'
		const encrypted = await exportAuthorization(config, cookie, 'test-password')
		expect(encrypted).toMatch(/^VSA1\./)
		expect(encrypted).not.toContain('synthetic')
		expect(encrypted).not.toContain('test-root')
		const result = await importAuthorization(encrypted, 'test-password')
		expect(result.cookie).toBe(cookie)
		expect(result.config).toEqual({
			...config,
			cookieFile: defaultConfig.cookieFile,
			allowDeletes: false,
		})
	})

	it('rejects a wrong password and tampered ciphertext with a safe message', async () => {
		const value = await exportAuthorization(
			{ ...defaultConfig, rootFolderId: 'root' },
			'__uid=test; __kps=synthetic-secret',
			'test-password',
		)
		await expect(
			importAuthorization(value, 'wrong-password'),
		).rejects.toMatchObject({ code: 'AUTH_DECRYPT' })
		const envelope = JSON.parse(
			Buffer.from(value.slice(5), 'base64').toString(),
		)
		const ciphertext = Buffer.from(envelope.data, 'base64')
		ciphertext[0] ^= 255
		envelope.data = ciphertext.toString('base64')
		const corrupt =
			'VSA1.' + Buffer.from(JSON.stringify(envelope)).toString('base64')
		await expect(
			importAuthorization(corrupt, 'test-password'),
		).rejects.toMatchObject({ code: 'AUTH_DECRYPT' })
	})

	it('expires authorization after a day without affecting the credential itself', async () => {
		const issued = Date.now()
		const value = await exportAuthorization(
			{ ...defaultConfig, rootFolderId: 'root' },
			'__uid=test; __kps=synthetic',
			'test-password',
		)
		vi.useFakeTimers()
		vi.setSystemTime(issued + 25 * 60 * 60 * 1000)
		await expect(
			importAuthorization(value, 'test-password'),
		).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
	})

	it('refuses short passwords and invalid or oversized payloads', async () => {
		await expect(
			exportAuthorization(
				{ ...defaultConfig, rootFolderId: 'root' },
				'__uid=test',
				'short',
			),
		).rejects.toMatchObject({ code: 'AUTH_PASSWORD' })
		await expect(
			importAuthorization('raw-cookie', 'test-password'),
		).rejects.toMatchObject({ code: 'AUTH_FORMAT' })
		await expect(
			importAuthorization('VSA1.' + 'a'.repeat(33000), 'test-password'),
		).rejects.toMatchObject({ code: 'AUTH_FORMAT' })
	})
})
