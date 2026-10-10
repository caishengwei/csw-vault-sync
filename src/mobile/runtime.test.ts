import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { defaultConfig } from '../headless/configuration'
import { MockQuark } from '../headless/test-support'
import { mobileTestApp, TestFile } from './test-support'
import type { MobileVaultContext } from './runtime'

describe('mobile runtime without Node APIs', () => {
	let Constructor: typeof MobileVaultContext
	let root: string
	let server: MockQuark
	let context: MobileVaultContext
	let host: ReturnType<typeof mobileTestApp>
	beforeAll(async () => {
		const result = await build({
			entryPoints: ['src/mobile/runtime.ts'],
			bundle: true,
			platform: 'browser',
			format: 'cjs',
			write: false,
			external: ['obsidian'],
		})
		const module = {
			exports: {} as { MobileVaultContext: typeof MobileVaultContext },
		}
		runInNewContext(result.outputFiles[0].text, {
			module,
			exports: module.exports,
			require: (name: string) => {
				if (name === 'obsidian') return { TFile: TestFile }
				throw new Error('Node API forbidden: ' + name)
			},
			crypto: webcrypto,
			TextEncoder,
			TextDecoder,
			URL,
			AbortController,
			AbortSignal,
			setTimeout,
			clearTimeout,
		})
		Constructor = module.exports.MobileVaultContext
	})
	beforeEach(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'vault-sync-mobile-'))
		host = mobileTestApp(root)
		context = new Constructor(host.app)
		server = new MockQuark()
		const config = { ...defaultConfig, rootFolderId: 'root' }
		await context.saveCookie(config, '__uid=test-user; __kps=synthetic-cookie')
		await context.writeConfig(config)
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})
	const sync = (options = {}) =>
		context.run('sync', { transport: server.transport, ...options })

	it('uploads, downloads, merges changes and uses the Vault API to refresh device notes', async () => {
		await fs.writeFile(join(root, 'local.md'), 'one\ntwo\nthree\n')
		server.add('folder/remote.md', 'from cloud')
		const initial = await sync()
		expect('failed' in initial && initial.failed).toEqual([])
		expect(await fs.readFile(join(root, 'folder/remote.md'), 'utf8')).toBe(
			'from cloud',
		)
		expect(host.calls).toContain('createFolder')
		expect(host.calls).toContain('createBinary')
		await fs.writeFile(join(root, 'local.md'), 'ONE\ntwo\nthree\n')
		server.edit('local.md', 'one\ntwo\nTHREE\n')
		const merged = await sync()
		expect('failed' in merged && merged.failed).toEqual([])
		expect(await fs.readFile(join(root, 'local.md'), 'utf8')).toBe(
			'ONE\ntwo\nTHREE\n',
		)
		expect(host.calls).toContain('modifyBinary')
		expect(await fs.readdir(join(root, '.vault-sync/backups'))).toHaveLength(1)
		const again = await sync()
		expect('completed' in again && again.completed).toBe(0)
	})

	it('keeps preview read-only and excludes credentials and device configuration', async () => {
		await fs.writeFile(join(root, 'local.md'), 'note')
		await fs.mkdir(join(root, '.obsidian'))
		await fs.writeFile(join(root, '.obsidian/data.json'), 'private')
		const result = await context.run('preview', { transport: server.transport })
		expect(
			'actions' in result && result.actions.map((action) => action.path),
		).toEqual(['local.md'])
		expect(server.files.size).toBe(0)
		expect(host.calls).toEqual([])
		expect(await host.adapter.exists('.vault-sync/status.json')).toBe(false)
	})

	it('protects conflicts and moves deletion into recoverable device storage', async () => {
		await fs.writeFile(join(root, 'note.md'), 'original')
		await fs.writeFile(join(root, 'keep.md'), 'keep')
		const initial = await sync()
		expect('failed' in initial && initial.failed).toEqual([])
		await fs.writeFile(join(root, 'note.md'), 'local edit')
		server.edit('note.md', 'remote edit')
		const conflict = await sync()
		expect('conflicts' in conflict && conflict.conflicts).toEqual(['note.md'])
		await fs.writeFile(join(root, 'note.md'), 'original')
		server.edit('note.md', 'original')
		await sync()
		server.files.delete(server.get('note.md')!.fid)
		await sync({ allowDeletes: true })
		expect(await host.adapter.exists('note.md')).toBe(false)
		expect(host.calls).toContain('rename')
		const trash = await fs.readdir(join(root, '.vault-sync/trash'))
		expect(
			await fs.readFile(join(root, '.vault-sync/trash', trash[0]), 'utf8'),
		).toBe('original')
	})

	it('prevents overlapping operations and does not remove another operation lock', async () => {
		const release = await context.acquireLock()
		await expect(sync()).rejects.toMatchObject({ code: 'LOCKED' })
		await release()
		await host.adapter.mkdir('.vault-sync/lock')
		await expect(sync()).rejects.toMatchObject({ code: 'LOCKED' })
		expect(await host.adapter.exists('.vault-sync/lock')).toBe(true)
	})

	it('stops for corrupted history, incomplete local listings and unsafe paths', async () => {
		await fs.writeFile(join(root, 'note.md'), 'note')
		await sync()
		const state = (await fs.readdir(join(root, '.vault-sync'))).find((name) =>
			name.startsWith('state-'),
		)!
		await host.adapter.write('.vault-sync/' + state, '{invalid')
		server.requests.length = 0
		await expect(sync()).rejects.toMatchObject({ code: 'STATE_CORRUPT' })
		expect(server.requests).toEqual([])
		await host.adapter.remove('.vault-sync/' + state)
		const original = host.adapter.list
		host.adapter.list = async (path) =>
			path ? original(path) : { files: ['../outside.md'], folders: [] }
		await expect(sync()).rejects.toMatchObject({ code: 'INVALID_PATH' })
	})
})
