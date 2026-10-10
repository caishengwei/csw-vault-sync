import { describe, expect, it, vi } from 'vitest'

// Mock obsidian (no proper Node export)
vi.mock('obsidian', () => ({
	normalizePath: (p: string) => p,
	Vault: class {},
	Platform: { isDesktopApp: true, isAndroidApp: false },
	requireApiVersion: () => false,
}))

// Mock ~/settings to avoid pulling in the entire settings/UI dependency chain
vi.mock('~/settings', () => ({
	SyncMode: { STRICT: 'strict', LOOSE: 'loose' },
	useSettings: vi.fn().mockResolvedValue(null),
}))

// Mock ~/utils/logger to avoid side effects
vi.mock('~/utils/logger', () => ({
	default: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}))

// Mock ~/utils/has-invalid-char
vi.mock('~/utils/has-invalid-char', () => ({
	hasInvalidChar: () => false,
	hasFilenameError: () => false,
}))

// Mock task-related modules that import heavy dependencies
vi.mock('~/utils/get-task-name', () => ({
	default: () => 'MockTask',
}))

// Mock ~/storage modules
vi.mock('~/storage', () => ({
	syncRecordKV: {},
	traverseRemoteKV: { get: vi.fn(), set: vi.fn() },
}))

vi.mock('~/storage/sync-record', () => ({
	SyncRecord: class {
		getRecords() { return new Map() }
		drop() {}
	},
}))

vi.mock('~/storage/blob', () => ({
	blobStore: { get: vi.fn() },
}))

// Mock remote storage interface
vi.mock('~/remote-storage/remote-storage.interface', () => ({
	default: class {},
}))

// Mock i18n
vi.mock('~/i18n', () => ({
	default: { t: (key: string) => key },
}))

// Mock API modules
vi.mock('~/utils/api-limiter', () => ({
	apiLimiter: { wrap: (fn: any) => fn },
}))
vi.mock('~/consts', () => ({
	VALID_REQURL: false,
}))

// Mock events
vi.mock('~/events', () => ({
	emitEndSync: vi.fn(),
	emitPreparingSync: vi.fn(),
	emitStartSync: vi.fn(),
	emitSyncError: vi.fn(),
	emitSyncProgress: vi.fn(),
	onCancelSync: vi.fn(),
}))

vi.mock('~/events/sso-receive', () => ({
	onSsoReceive: vi.fn(),
}))

// Mock merge-dig-in
vi.mock('~/utils/merge-dig-in', () => ({
	mergeDigIn: vi.fn(),
}))

import { FsWalkResult } from '~/fs/fs.interface'
import {
	SyncDecisionInput,
	SyncRecordItem,
	TaskFactory,
} from '../decision/sync-decision.interface'
import { twoWayDecider } from '../decision/two-way.decider.function'

/**
 * Helper to build a local file stat
 */
function localFile(path: string, mtime: number, size: number = 100): FsWalkResult {
	return {
		stat: { path, basename: path.split('/').pop()!, isDir: false, isDeleted: false, mtime, size },
		ignored: false,
	}
}

/**
 * Helper to build a local folder stat
 */
function localFolder(path: string): FsWalkResult {
	return {
		stat: { path, basename: path.split('/').pop()!, isDir: true, isDeleted: false },
		ignored: false,
	}
}

/**
 * Helper to build a remote file stat
 */
function remoteFile(path: string, mtime: number, size: number = 100): FsWalkResult {
	return {
		stat: { path, basename: path.split('/').pop()!, isDir: false, isDeleted: false, mtime, size },
		ignored: false,
	}
}

/**
 * Helper to build a remote folder stat
 */
function remoteFolder(path: string): FsWalkResult {
	return {
		stat: { path, basename: path.split('/').pop()!, isDir: true, isDeleted: false },
		ignored: false,
	}
}

/**
 * Helper to build a sync record for a file
 */
function fileRecord(
	path: string,
	localMtime: number,
	remoteMtime: number,
	size: number = 100,
): [string, SyncRecordItem] {
	return [
		path,
		{
			local: { path, basename: path.split('/').pop()!, isDir: false, isDeleted: false, mtime: localMtime, size },
			remote: { path, basename: path.split('/').pop()!, isDir: false, isDeleted: false, mtime: remoteMtime, size },
		},
	]
}

/**
 * Helper to build a sync record for a folder
 */
function folderRecord(path: string): [string, SyncRecordItem] {
	return [
		path,
		{
			local: { path, basename: path.split('/').pop()!, isDir: true, isDeleted: false },
			remote: { path, basename: path.split('/').pop()!, isDir: true, isDeleted: false },
		},
	]
}

/**
 * Create a mock TaskFactory that records which tasks are created
 */
function createMockTaskFactory() {
	const createdTasks: Array<{ type: string; localPath: string; remotePath: string }> = []

	const mockTask = (type: string) => (options: any) => {
		createdTasks.push({
			type,
			localPath: options.localPath,
			remotePath: options.remotePath,
		})
		return {
			localPath: options.localPath,
			remotePath: options.remotePath,
			remoteBaseDir: options.remoteBaseDir,
			options,
			exec: vi.fn(),
		} as any
	}

	const factory: TaskFactory = {
		createPullTask: mockTask('pull'),
		createPushTask: mockTask('push'),
		createConflictResolveTask: mockTask('conflict'),
		createNoopTask: mockTask('noop'),
		createRemoveLocalTask: mockTask('removeLocal'),
		createRemoveRemoteTask: mockTask('removeRemote'),
		createMkdirLocalTask: mockTask('mkdirLocal'),
		createMkdirRemoteTask: mockTask('mkdirRemote'),
		createCleanRecordTask: mockTask('cleanRecord'),
		createFilenameErrorTask: mockTask('filenameError'),
		createSkippedTask: mockTask('skipped'),
	}

	return { factory, createdTasks }
}

function createInput(overrides: Partial<SyncDecisionInput>): SyncDecisionInput {
	const { factory } = createMockTaskFactory()
	return {
		settings: {
			skipLargeFiles: { maxSize: '' },
			conflictStrategy: 'diff-match-patch' as any,
			useGitStyle: false,
			syncMode: 'strict' as any,
		},
		localStats: [],
		remoteStats: [],
		syncRecords: new Map(),
		remoteBaseDir: '/remote/vault',
		getBaseContent: vi.fn().mockResolvedValue(null),
		compareFileContent: vi.fn().mockResolvedValue(false),
		taskFactory: factory,
		...overrides,
	}
}

describe('twoWayDecider - remote empty protection', () => {
	it('场景1: 远端完全为空(无文件无文件夹) + 有同步记录 + 本地有文件 → 应该 push 而不是删除本地', async () => {
		const { factory, createdTasks } = createMockTaskFactory()

		const localStats: FsWalkResult[] = [
			localFolder('docs'),
			localFile('docs/note1.md', 1000),
			localFile('docs/note2.md', 1000),
			localFile('readme.md', 1000),
		]

		const remoteStats: FsWalkResult[] = [] // 远端完全为空

		// 同步记录表明之前同步过（mtime 与本地一致 → localChanged = false）
		const syncRecords = new Map<string, SyncRecordItem>([
			folderRecord('docs'),
			fileRecord('docs/note1.md', 1000, 1000),
			fileRecord('docs/note2.md', 1000, 1000),
			fileRecord('readme.md', 1000, 1000),
		])

		const input = createInput({
			localStats,
			remoteStats,
			syncRecords,
			taskFactory: factory,
		})

		await twoWayDecider(input)

		// 不应该有任何 removeLocal 任务
		const removeLocalTasks = createdTasks.filter((t) => t.type === 'removeLocal')
		expect(removeLocalTasks).toHaveLength(0)

		// 应该有 push 任务（文件被推到远端）
		const pushTasks = createdTasks.filter((t) => t.type === 'push')
		expect(pushTasks.length).toBeGreaterThanOrEqual(3) // 3 个文件

		// 应该有 mkdirRemote 任务（文件夹被创建到远端）
		const mkdirRemoteTasks = createdTasks.filter((t) => t.type === 'mkdirRemote')
		expect(mkdirRemoteTasks.length).toBeGreaterThanOrEqual(1) // docs 文件夹
	})

	it('场景2: 远端有文件夹但没有文件 + 有同步记录 + 本地有文件 → 应该 push 而不是删除本地', async () => {
		const { factory, createdTasks } = createMockTaskFactory()

		const localStats: FsWalkResult[] = [
			localFolder('docs'),
			localFile('docs/note1.md', 1000),
			localFile('docs/note2.md', 1000),
			localFile('readme.md', 1000),
		]

		// 远端只有空文件夹结构，没有任何文件
		const remoteStats: FsWalkResult[] = [remoteFolder('docs')]

		// 同步记录表明之前同步过
		const syncRecords = new Map<string, SyncRecordItem>([
			folderRecord('docs'),
			fileRecord('docs/note1.md', 1000, 1000),
			fileRecord('docs/note2.md', 1000, 1000),
			fileRecord('readme.md', 1000, 1000),
		])

		const input = createInput({
			localStats,
			remoteStats,
			syncRecords,
			taskFactory: factory,
		})

		await twoWayDecider(input)

		// 不应该有任何 removeLocal 任务
		const removeLocalTasks = createdTasks.filter((t) => t.type === 'removeLocal')
		expect(removeLocalTasks).toHaveLength(0)

		// 应该有 push 任务
		const pushTasks = createdTasks.filter((t) => t.type === 'push')
		expect(pushTasks.length).toBeGreaterThanOrEqual(3) // 3 个文件
	})

	it('场景3: 远端为空 + 没有同步记录 + 本地有文件 → 首次同步，应该全部 push', async () => {
		const { factory, createdTasks } = createMockTaskFactory()

		const localStats: FsWalkResult[] = [
			localFolder('docs'),
			localFile('docs/note1.md', 1000),
			localFile('readme.md', 1000),
		]

		const remoteStats: FsWalkResult[] = []
		const syncRecords = new Map<string, SyncRecordItem>()

		const input = createInput({
			localStats,
			remoteStats,
			syncRecords,
			taskFactory: factory,
		})

		await twoWayDecider(input)

		// 应该全部是 push 和 mkdirRemote
		const removeLocalTasks = createdTasks.filter((t) => t.type === 'removeLocal')
		expect(removeLocalTasks).toHaveLength(0)

		const pushTasks = createdTasks.filter((t) => t.type === 'push')
		expect(pushTasks.length).toBe(2) // 2 个文件
	})

	it('场景4: 正常删除场景 - 远端有文件 + 远端删了1个 + 本地没改 → 应该删除本地那个文件', async () => {
		const { factory, createdTasks } = createMockTaskFactory()

		const localStats: FsWalkResult[] = [
			localFolder('docs'),
			localFile('docs/note1.md', 1000),
			localFile('docs/note2.md', 1000), // 本地还在
			localFile('readme.md', 1000),
		]

		const remoteStats: FsWalkResult[] = [
			remoteFolder('docs'),
			remoteFile('docs/note1.md', 1000),
			// note2.md 已经被远端删除
			remoteFile('readme.md', 1000),
		]

		const syncRecords = new Map<string, SyncRecordItem>([
			folderRecord('docs'),
			fileRecord('docs/note1.md', 1000, 1000),
			fileRecord('docs/note2.md', 1000, 1000),
			fileRecord('readme.md', 1000, 1000),
		])

		const input = createInput({
			localStats,
			remoteStats,
			syncRecords,
			taskFactory: factory,
		})

		await twoWayDecider(input)

		// 正常场景：远端仍有其他文件，只删了1个 → 应该确实删除本地的那1个
		const removeLocalTasks = createdTasks.filter((t) => t.type === 'removeLocal')
		expect(removeLocalTasks).toHaveLength(1)
		expect(removeLocalTasks[0].localPath).toBe('docs/note2.md')
	})
})

describe('twoWayDecider - remote has only folders (no files)', () => {
	it('远端只有空文件夹 + 有同步记录 → 应该保护本地文件不被删除', async () => {
		const { factory, createdTasks } = createMockTaskFactory()

		const localStats: FsWalkResult[] = [
			localFolder('folder-a'),
			localFolder('folder-a/sub'),
			localFile('folder-a/sub/file1.md', 1000),
			localFile('folder-a/file2.md', 1000),
		]

		// 远端只有文件夹结构，所有文件都被清空了
		const remoteStats: FsWalkResult[] = [
			remoteFolder('folder-a'),
			remoteFolder('folder-a/sub'),
		]

		const syncRecords = new Map<string, SyncRecordItem>([
			folderRecord('folder-a'),
			folderRecord('folder-a/sub'),
			fileRecord('folder-a/sub/file1.md', 1000, 1000),
			fileRecord('folder-a/file2.md', 1000, 1000),
		])

		const input = createInput({
			localStats,
			remoteStats,
			syncRecords,
			taskFactory: factory,
		})

		await twoWayDecider(input)

		// 不应该有 removeLocal 任务 — 文件应该被 push 回远端
		const removeLocalTasks = createdTasks.filter((t) => t.type === 'removeLocal')
		expect(removeLocalTasks).toHaveLength(0)

		// 应该有 push 任务把文件推回远端
		const pushTasks = createdTasks.filter((t) => t.type === 'push')
		expect(pushTasks.length).toBe(2)
	})
})
