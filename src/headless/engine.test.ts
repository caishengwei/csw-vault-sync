import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, saveCookie, writeConfig } from './config'
import { runQuark } from './runtime'
import { acquireLock } from './state'
import { MockQuark } from './test-support'
import { QuarkFileStore } from './quark'
import { sha256 } from './local'

describe('shared sync with real isolated filesystem and simulated Quark API', () => {
	let vault: string
	let server: MockQuark
	beforeEach(async () => {
		vault = await fs.mkdtemp(join(tmpdir(), 'vault-sync-test-'))
		server = new MockQuark()
		const config = { ...defaultConfig, rootFolderId: 'root' }
		await writeConfig(vault, config)
		await saveCookie(vault, config, '__uid=test-user; __kps=synthetic-cookie')
	})
	afterEach(async () => {
		await fs.rm(vault, { recursive: true, force: true })
	})
	const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
	const write = async (path: string, content: string) => {
		await fs.mkdir(join(vault, path, '..'), { recursive: true })
		await fs.writeFile(join(vault, path), content)
	}
	const sync = () => runQuark(vault, 'sync', { transport: server.transport })

	it('uploads and downloads, persists baseline, and leaves subsequent run unchanged', async () => {
		await write('local.md', 'local note')
		server.add('folder/remote.md', 'remote note')
		const result = await sync()
		expect('failed' in result && result.failed).toEqual([])
		expect(text(server.get('local.md')!.bytes)).toBe('local note')
		expect(await fs.readFile(join(vault, 'folder/remote.md'), 'utf8')).toBe(
			'remote note',
		)
		const second = await sync()
		expect('completed' in second && second.completed).toBe(0)
		expect('unchanged' in second && second.unchanged).toBeGreaterThanOrEqual(2)
	})

	it('preview reads metadata/content but never changes local notes or remote files', async () => {
		await write('local.md', 'note')
		server.add('remote.md', 'remote')
		const before = [...server.files.values()].map((file) => ({ ...file }))
		const preview = await runQuark(vault, 'preview', {
			transport: server.transport,
		})
		expect(
			'actions' in preview && preview.actions.map((item) => item.type).sort(),
		).toEqual(['pull', 'push'])
		expect([...server.files.values()]).toEqual(before)
		expect(await fs.readdir(vault)).toEqual(['.vault-sync', 'local.md'])
		expect(await fs.readdir(join(vault, '.vault-sync'))).not.toContain(
			'status.json',
		)
		expect(
			server.requests.every(
				(request) =>
					request.method === 'GET' || request.url.includes('/file/download?'),
			),
		).toBe(true)
	})

	it('preserves both different versions on first sync', async () => {
		await write('note.md', 'local')
		server.add('note.md', 'remote')
		const result = await sync()
		expect('conflicts' in result && result.conflicts).toEqual(['note.md'])
		expect(await fs.readFile(join(vault, 'note.md'), 'utf8')).toBe('local')
		expect(text(server.get('note.md')!.bytes)).toBe('remote')
	})

	it('updates a locally edited file and pulls a remotely edited file using shared history', async () => {
		await write('a.md', 'old a')
		await write('b.md', 'old b')
		await sync()
		await write('a.md', 'new a')
		server.edit('b.md', 'new b')
		const result = await sync()
		expect('failed' in result && result.failed).toEqual([])
		expect(text(server.get('a.md')!.bytes)).toBe('new a')
		expect(await fs.readFile(join(vault, 'b.md'), 'utf8')).toBe('new b')
	})

	it('merges independent text changes and preserves overlapping changes', async () => {
		await write('note.md', 'one\ntwo\nthree\n')
		await sync()
		await write('note.md', 'ONE\ntwo\nthree\n')
		server.edit('note.md', 'one\ntwo\nTHREE\n')
		const merged = await sync()
		expect('conflicts' in merged && merged.conflicts).toEqual([])
		expect(await fs.readFile(join(vault, 'note.md'), 'utf8')).toBe(
			'ONE\ntwo\nTHREE\n',
		)
		await write('note.md', 'LOCAL\ntwo\nTHREE\n')
		server.edit('note.md', 'REMOTE\ntwo\nTHREE\n')
		const conflict = await sync()
		expect('conflicts' in conflict && conflict.conflicts).toEqual(['note.md'])
		expect(text(server.get('note.md')!.bytes)).toBe('REMOTE\ntwo\nTHREE\n')
	})

	it('does not propagate deletion by default, then propagates with explicit override', async () => {
		await write('note.md', 'content')
		await sync()
		await fs.unlink(join(vault, 'note.md'))
		const blocked = await sync()
		expect('skipped' in blocked && blocked.skipped).toEqual(['note.md'])
		expect(server.get('note.md')).toBeDefined()
		const allowed = await runQuark(vault, 'sync', {
			transport: server.transport,
			allowDeletes: true,
		})
		expect('failed' in allowed && allowed.failed).toEqual([])
		expect(server.get('note.md')).toBeUndefined()
	})

	it('moves local deletions to recoverable storage and preserves delete-versus-edit conflicts', async () => {
		await write('safe.md', 'recover me')
		await write('conflict.md', 'old')
		await write('keep.md', 'unchanged')
		await sync()
		server.files.delete(server.get('safe.md')!.fid)
		server.files.delete(server.get('conflict.md')!.fid)
		await write('conflict.md', 'keep this change')
		const result = await runQuark(vault, 'sync', {
			transport: server.transport,
			allowDeletes: true,
		})
		expect('conflicts' in result && result.conflicts).toEqual(['conflict.md'])
		const backups = await fs.readdir(join(vault, '.vault-sync/trash'))
		expect(
			await fs.readFile(join(vault, '.vault-sync/trash', backups[0]), 'utf8'),
		).toBe('recover me')
		expect(await fs.readFile(join(vault, 'conflict.md'), 'utf8')).toBe(
			'keep this change',
		)
	})

	it('protects local files when the entire remote tree is empty even when deletes are enabled', async () => {
		await write('note.md', 'must survive an empty remote listing')
		await sync()
		server.files.clear()
		const result = await runQuark(vault, 'sync', {
			transport: server.transport,
			allowDeletes: true,
		})
		expect('skipped' in result && result.skipped).toEqual(['note.md'])
		expect(await fs.readFile(join(vault, 'note.md'), 'utf8')).toBe(
			'must survive an empty remote listing',
		)
	})

	it('excludes credentials, Git, app configuration and user filters from both sides', async () => {
		await write('.git/config', 'private repository configuration')
		await write('.obsidian/data.json', 'app credentials')
		await write('credentials.txt', 'another synthetic cookie')
		await write('skip/local.txt', 'not synced')
		const config = {
			...defaultConfig,
			rootFolderId: 'root',
			cookieFile: 'credentials.txt',
			exclude: ['skip/**'],
		}
		await saveCookie(vault, config, '__uid=test-user; __kps=synthetic-cookie')
		await writeConfig(vault, config)
		server.add('.obsidian/remote.json', 'must not download')
		server.add('skip/remote.txt', 'must not download')
		const result = await sync()
		expect('completed' in result && result.completed).toBe(0)
		expect(server.get('credentials.txt')).toBeUndefined()
		expect(await fs.readdir(join(vault, '.obsidian'))).toEqual(['data.json'])
	})

	it('enforces a cross-process filesystem lock and releases it after failure', async () => {
		const release = await acquireLock(vault)
		await expect(sync()).rejects.toMatchObject({ code: 'LOCKED' })
		await release()
		server.transport = async () => {
			throw new Error('simulated secret response')
		}
		await expect(sync()).rejects.toThrow()
		expect(await fs.readdir(join(vault, '.vault-sync'))).not.toContain('lock')
	})

	it('refuses malformed state before any remote file mutation', async () => {
		const remote = new QuarkFileStore(
			'__uid=test-user; __kps=synthetic-cookie',
			'root',
			server.transport,
			defaultConfig.maxFileSize,
		)
		await fs.writeFile(
			join(vault, '.vault-sync', `state-${remote.mountIdentity}.json`),
			'{invalid',
		)
		await expect(sync()).rejects.toMatchObject({ code: 'STATE_CORRUPT' })
		expect(server.requests).toEqual([])
	})

	it('refuses traversal, local symlinks and case-colliding paths without touching external files', async () => {
		server.add('../outside.md', 'unsafe')
		await expect(sync()).rejects.toMatchObject({ code: 'INVALID_PATH' })
		server = new MockQuark()
		await fs.symlink(
			join(vault, '.vault-sync/config.json'),
			join(vault, 'link.md'),
		)
		server.add('link.md', 'must not overwrite')
		await expect(sync()).rejects.toMatchObject({ code: 'SYMLINK' })
		expect((await fs.lstat(join(vault, 'link.md'))).isSymbolicLink()).toBe(true)
		await fs.unlink(join(vault, 'link.md'))
		await write('Note.md', 'local')
		server.add('note.md', 'remote')
		await expect(sync()).rejects.toMatchObject({ code: 'AMBIGUOUS_PATH' })
	})

	it.each(['file', 'directory'])(
		'preserves remote files when a tracked %s is replaced by a symlink with deletion enabled',
		async (kind) => {
			const path = kind === 'file' ? 'note.md' : 'folder/note.md'
			await write(path, 'must remain on remote')
			await sync()
			const linkedPath = kind === 'file' ? 'note.md' : 'folder'
			await fs.rm(join(vault, linkedPath), { recursive: true })
			await fs.symlink(join(vault, '.vault-sync'), join(vault, linkedPath))
			server.requests.length = 0
			await expect(
				runQuark(vault, 'sync', {
					transport: server.transport,
					allowDeletes: true,
				}),
			).rejects.toMatchObject({ code: 'SYMLINK' })
			expect(text(server.get(path)!.bytes)).toBe('must remain on remote')
			expect(
				server.requests.some((request) =>
					/\/file\/(delete|rename|upload)\b/.test(request.url),
				),
			).toBe(false)
		},
	)

	it('retains old remote contents when multipart upload validation or rename fails', async () => {
		await write('note.md', 'old')
		await sync()
		await write('note.md', 'replacement')
		server.corruptUpload = true
		const corrupt = await sync()
		expect('failed' in corrupt && corrupt.failed).toHaveLength(1)
		expect(text(server.get('note.md')!.bytes)).toBe('old')
		server.corruptUpload = false
		server.failRename = true
		const failure = await sync()
		expect('failed' in failure && failure.failed).toHaveLength(1)
		expect(text(server.get('note.md')!.bytes)).toBe('old')
		expect(await fs.readFile(join(vault, 'note.md'), 'utf8')).toBe(
			'replacement',
		)
	})

	it('detects remote changes during upload instead of replacing them', async () => {
		await write('note.md', 'old')
		await sync()
		await write('note.md', 'local change')
		server.beforeFinish = () =>
			server.edit('note.md', 'concurrent remote change')
		const result = await sync()
		expect('failed' in result && result.failed).toHaveLength(1)
		expect(text(server.get('note.md')!.bytes)).toBe('concurrent remote change')
	})

	it('signs multipart upload requests and never forwards Cookie to object storage', async () => {
		await write('note.md', 'abcdefghij')
		await sync()
		const signatures = server.requests
			.filter((request) => request.url.includes('/upload/auth?'))
			.map((request) => JSON.parse(request.body as string).auth_meta)
		expect(signatures).toHaveLength(5)
		expect(signatures[0]).toMatch(
			/^PUT\n\napplication\/octet-stream\n[^\n]+\nx-oss-date:/,
		)
		expect(signatures[4]).toMatch(/^POST\n[A-Za-z0-9+/]+=*\napplication\/xml\n/)
		const objectRequests = server.requests.filter((request) =>
			new URL(request.url).hostname.endsWith('.aliyuncs.com'),
		)
		expect(objectRequests.every((request) => !request.headers?.Cookie)).toBe(
			true,
		)
		expect(sha256(server.get('note.md')!.bytes)).toBe(
			sha256(new TextEncoder().encode('abcdefghij')),
		)
	})

	it('cancels between operations while preserving completed work and releasing lock', async () => {
		await write('a.md', 'a')
		await write('b.md', 'b')
		const controller = new AbortController()
		const result = await runQuark(vault, 'sync', {
			transport: server.transport,
			signal: controller.signal,
			onProgress: () => controller.abort(),
		})
		expect('cancelled' in result && result.cancelled).toBe(true)
		expect(server.get('a.md')).toBeDefined()
		expect(server.get('b.md')).toBeUndefined()
		expect(await fs.readdir(join(vault, '.vault-sync'))).not.toContain('lock')
		const next = await sync()
		expect('failed' in next && next.failed).toEqual([])
		expect(server.get('b.md')).toBeDefined()
	})

	it('isolates new accounts and never applies deletion history from a previous account', async () => {
		await write('note.md', 'first account')
		await sync()
		await fs.unlink(join(vault, 'note.md'))
		await saveCookie(
			vault,
			{ ...defaultConfig, rootFolderId: 'root' },
			'__uid=second-user; __kps=another-synthetic-cookie',
		)
		const result = await runQuark(vault, 'sync', {
			transport: server.transport,
			allowDeletes: true,
		})
		expect('failed' in result && result.failed).toEqual([])
		expect(server.get('note.md')).toBeDefined()
		expect(await fs.readFile(join(vault, 'note.md'), 'utf8')).toBe(
			'first account',
		)
	})
})
