export interface FileEntry {
	path: string
	kind: 'file' | 'directory'
	size: number
	revision: string
	hash?: string
}

export interface FileStore {
	list(signal?: AbortSignal): Promise<FileEntry[]>
	stat(path: string, signal?: AbortSignal): Promise<FileEntry | undefined>
	read(path: string, signal?: AbortSignal): Promise<Uint8Array>
	write(
		path: string,
		content: Uint8Array,
		expected: FileEntry | undefined,
		signal?: AbortSignal,
	): Promise<void>
	remove(path: string, expected: FileEntry, signal?: AbortSignal): Promise<void>
	mkdir(path: string, signal?: AbortSignal): Promise<void>
}

export interface FileRecord {
	hash: string
	remoteRevision: string
	size: number
	baseText?: string
}

export interface SyncState {
	version: 1
	mount: string
	files: Record<string, FileRecord>
	lastRun?: SyncResult
}

export type ActionType =
	| 'push'
	| 'pull'
	| 'merge'
	| 'adopt'
	| 'delete-local'
	| 'delete-remote'
	| 'mkdir-local'
	| 'mkdir-remote'
	| 'forget'
	| 'conflict'
	| 'skip'

export interface SyncAction {
	type: ActionType
	path: string
	reason?: string
	local?: FileEntry
	remote?: FileEntry
	merged?: Uint8Array
}

export interface SyncActivity {
	phase: 'scan' | 'compare' | 'sync'
	completed: number
	total?: number
	path?: string
	action?: ActionType
}

export interface SyncPlan {
	actions: SyncAction[]
	unchanged: number
}

export interface SyncResult {
	startedAt: string
	finishedAt: string
	completed: number
	unchanged: number
	conflicts: string[]
	skipped: string[]
	failed: Array<{ path: string; message: string }>
	cancelled: boolean
}

export interface SyncConfig {
	version: 1
	provider: 'quark'
	rootFolderId: string
	cookieFile: string
	maxFileSize: number
	exclude: string[]
	allowDeletes: boolean
	mergeText: boolean
}

export interface HttpRequest {
	url: string
	method: string
	headers?: Record<string, string>
	body?: string | Uint8Array
	signal?: AbortSignal
}

export interface HttpResponse {
	status: number
	headers: Record<string, string>
	body: Uint8Array
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>

export class SyncError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message)
		this.name = 'SyncError'
	}
}

export function checkAbort(signal?: AbortSignal) {
	if (signal?.aborted) throw new SyncError('CANCELLED', '同步已取消')
}

export function safeError(error: unknown): string {
	return error instanceof SyncError
		? error.message
		: '操作失败，请检查网络连接和本地文件权限'
}
