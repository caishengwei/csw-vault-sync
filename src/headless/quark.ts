import { decode } from 'html-entities'
import {
	sha256,
	matchesEntry,
	randomUUID,
	encode,
	md5Hex,
	sha1Hex,
	md5Base64,
	toBase64,
} from './common'
import { reservedPath, validPath } from './paths'
import {
	checkAbort,
	FileEntry,
	FileStore,
	HttpResponse,
	HttpTransport,
	SyncError,
} from './types'

const API = 'https://drive.quark.cn/1/clouddrive'
const OSS_AGENT = 'aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit'
const CLIENT_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4 Safari/537.36'
const encoder = new TextEncoder()

interface QuarkFile {
	fid: string
	file_name: string
	file: boolean
	size: number
	updated_at: number
	md5?: string
}

interface ApiResponse<T> {
	status: number
	code: number
	message?: string
	data: T
	metadata?: Record<string, number>
}

interface UploadTicket {
	task_id: string
	upload_id: string
	obj_key: string
	upload_url: string
	fid: string
	bucket: string
	callback: Record<string, unknown>
	format_type: string
	auth_info: string
}

function apiFailure(
	response: HttpResponse,
	body?: ApiResponse<unknown>,
): never {
	if (
		response.status === 401 ||
		response.status === 403 ||
		/login|登录|guest|授权|token/i.test(body?.message || '')
	) {
		throw new SyncError(
			'AUTH_REQUIRED',
			'夸克登录已失效或未授权，请更新本地 Cookie',
		)
	}
	if (
		response.status === 429 ||
		/频繁|限流|too many/i.test(body?.message || '')
	)
		throw new SyncError('RATE_LIMITED', '夸克请求受限，请稍后重试')
	throw new SyncError(
		'QUARK_API',
		`夸克请求失败（HTTP ${response.status}，code ${typeof body?.code === 'number' ? body.code : 'unknown'}）`,
	)
}

export class QuarkFileStore implements FileStore {
	private cookies: Map<string, string>
	constructor(
		cookie: string,
		readonly rootFolderId: string,
		private transport: HttpTransport,
		private maxFileSize: number,
		private ignored = reservedPath,
	) {
		this.cookies = new Map(
			cookie
				.split(';')
				.filter((part) => part.includes('='))
				.map((part): [string, string] => {
					const i = part.indexOf('=')
					return [part.slice(0, i).trim(), part.slice(i + 1).trim()]
				})
				.filter(([key]) => !!key),
		)
	}

	get cookie() {
		return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ')
	}

	get mountIdentity() {
		const principal =
			this.cookies.get('__uid') ||
			this.cookies.get('__kps') ||
			[...this.cookies]
				.filter(([key]) => !['__puus', '__pus'].includes(key))
				.map(([key, value]) => `${key}=${value}`)
				.sort()
				.join(';')
		return sha256(encode(`quark:${principal}:${this.rootFolderId}`)).slice(
			0,
			24,
		)
	}

	private async api<T>(
		path: string,
		body?: unknown,
		query: Record<string, string> = {},
		signal?: AbortSignal,
	): Promise<ApiResponse<T>> {
		checkAbort(signal)
		const url = new URL(API + path)
		url.searchParams.set('pr', 'ucpro')
		url.searchParams.set('fr', 'pc')
		for (const [key, value] of Object.entries(query))
			url.searchParams.set(key, value)
		const response = await this.transport({
			url: url.toString(),
			method: body === undefined ? 'GET' : 'POST',
			signal,
			headers: {
				Cookie: this.cookie,
				Referer: 'https://pan.quark.cn/',
				'User-Agent': CLIENT_AGENT,
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		for (const match of (response.headers['set-cookie'] || '').matchAll(
			/(?:^|,\s*)(__puus|__pus)=([^;,]*)/g,
		))
			this.cookies.set(match[1], match[2])
		let json: ApiResponse<T>
		try {
			json = JSON.parse(new TextDecoder().decode(response.body))
		} catch {
			return apiFailure(response)
		}
		if (
			response.status < 200 ||
			response.status >= 300 ||
			json.code !== 0 ||
			json.status >= 400
		)
			apiFailure(response, json)
		checkAbort(signal)
		return json
	}

	async testConnection(signal?: AbortSignal) {
		await this.api('/config', undefined, {}, signal)
		await this.directory(this.rootFolderId, signal)
		return {
			provider: 'quark',
			rootFolderId: this.rootFolderId,
			connected: true,
		}
	}

	private async directory(
		id: string,
		signal?: AbortSignal,
	): Promise<QuarkFile[]> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.directoryPages(id, signal)
			} catch (error) {
				if (
					!(error instanceof SyncError) ||
					error.code !== 'QUARK_PAGINATION' ||
					attempt >= 2
				)
					throw error
				await this.pause(500 * (attempt + 1), signal)
			}
		}
	}

	private async directoryPages(
		id: string,
		signal?: AbortSignal,
	): Promise<QuarkFile[]> {
		const files: QuarkFile[] = []
		const seen = new Set<string>()
		for (let page = 1; page <= 10000; page++) {
			const response = await this.api<{ list: QuarkFile[] }>(
				'/file/sort',
				undefined,
				{
					pdir_fid: id,
					_page: String(page),
					_size: '100',
					_fetch_total: '1',
					fetch_all_file: '1',
					fetch_risk_file_name: '1',
					_sort: 'file_type:asc,file_name:asc',
				},
				signal,
			)
			if (!Array.isArray(response.data?.list))
				throw new SyncError(
					'QUARK_SCHEMA',
					'夸克文件列表格式发生变化，已停止同步',
				)
			for (const item of response.data.list) {
				if (
					typeof item.fid !== 'string' ||
					typeof item.file_name !== 'string' ||
					typeof item.file !== 'boolean' ||
					!Number.isSafeInteger(item.size) ||
					item.size < 0 ||
					(item.file &&
						(!Number.isFinite(item.updated_at) || item.updated_at <= 0))
				) {
					throw new SyncError(
						'QUARK_SCHEMA',
						'夸克文件信息格式无效，已停止同步',
					)
				}
				if (seen.has(item.fid))
					throw new SyncError(
						'QUARK_PAGINATION',
						'夸克分页列表重复，未采用不完整列表',
					)
				seen.add(item.fid)
				files.push({ ...item, file_name: decode(item.file_name) })
			}
			const total = response.metadata?._total
			if (
				typeof total === 'number'
					? files.length >= total
					: response.data.list.length < 100
			)
				return files
			if (!response.data.list.length)
				throw new SyncError(
					'QUARK_PAGINATION',
					'夸克文件列表不完整，已停止同步',
				)
		}
		throw new SyncError('QUARK_PAGINATION', '夸克文件列表超过分页上限')
	}

	private entry(path: string, file: QuarkFile): FileEntry {
		return {
			path,
			kind: file.file ? 'file' : 'directory',
			size: file.file ? file.size : 0,
			revision: file.file
				? `${file.fid}:${file.updated_at}:${file.size}:${file.md5 || ''}`
				: 'directory',
		}
	}

	private async find(
		path: string,
		signal?: AbortSignal,
	): Promise<QuarkFile | undefined> {
		validPath(path)
		const parts = path.split('/')
		let parent = this.rootFolderId
		for (let i = 0; i < parts.length; i++) {
			const matches = (await this.directory(parent, signal)).filter(
				(file) => file.file_name === parts[i],
			)
			if (matches.length > 1)
				throw new SyncError(
					'AMBIGUOUS_PATH',
					'夸克目录中存在同名文件，已停止该操作',
				)
			if (!matches.length) return undefined
			const file = matches[0]
			if (i === parts.length - 1) return file
			if (file.file)
				throw new SyncError('PATH_TYPE', '远端父路径是文件，已停止该操作')
			parent = file.fid
		}
	}

	async list(signal?: AbortSignal): Promise<FileEntry[]> {
		const entries: FileEntry[] = []
		const queue = [{ id: this.rootFolderId, path: '' }]
		const seen = new Set<string>([this.rootFolderId])
		for (let i = 0; i < queue.length; i++) {
			const parent = queue[i]
			for (const file of await this.directory(parent.id, signal)) {
				const path = parent.path
					? `${parent.path}/${file.file_name}`
					: file.file_name
				validPath(path)
				if (this.ignored(path)) continue
				entries.push(this.entry(path, file))
				if (!file.file) {
					if (seen.has(file.fid))
						throw new SyncError(
							'QUARK_TREE',
							'夸克目录结构存在循环，已停止同步',
						)
					seen.add(file.fid)
					queue.push({ id: file.fid, path })
				}
			}
		}
		return entries
	}

	async stat(path: string, signal?: AbortSignal) {
		const file = await this.find(path, signal)
		return file ? this.entry(path, file) : undefined
	}

	private downloadUrl(value: string) {
		let url: URL
		try {
			url = new URL(value)
		} catch {
			throw new SyncError('QUARK_URL', '夸克返回了无效的下载地址')
		}
		if (
			url.protocol !== 'https:' ||
			url.username ||
			url.password ||
			!['quark.cn', 'uc.cn', 'aliyuncs.com'].some(
				(domain) =>
					url.hostname === domain || url.hostname.endsWith('.' + domain),
			)
		) {
			throw new SyncError('QUARK_URL', '夸克下载地址不在允许的域名范围内')
		}
		return url
	}

	async read(path: string, signal?: AbortSignal) {
		const file = await this.find(path, signal)
		if (!file?.file) throw new SyncError('REMOTE_MISSING', '远端文件不存在')
		if (file.size > this.maxFileSize)
			throw new SyncError('FILE_LIMIT', '远端文件超过大小上限')
		const response = await this.api<Array<{ download_url: string }>>(
			'/file/download',
			{ fids: [file.fid] },
			{},
			signal,
		)
		let url = this.downloadUrl(response.data?.[0]?.download_url)
		for (let redirect = 0; redirect < 5; redirect++) {
			const cookie =
				url.hostname === 'quark.cn' ||
				url.hostname.endsWith('.quark.cn') ||
				url.hostname.endsWith('.uc.cn')
			const download = await this.transport({
				url: url.toString(),
				method: 'GET',
				signal,
				headers: {
					Referer: 'https://pan.quark.cn/',
					'User-Agent': CLIENT_AGENT,
					...(cookie ? { Cookie: this.cookie } : {}),
				},
			})
			if (
				download.status >= 300 &&
				download.status < 400 &&
				download.headers.location
			) {
				url = this.downloadUrl(
					new URL(download.headers.location, url).toString(),
				)
				continue
			}
			if (download.status !== 200) apiFailure(download)
			if (
				download.body.byteLength !== file.size ||
				download.body.byteLength > this.maxFileSize
			)
				throw new SyncError(
					'DOWNLOAD_SIZE',
					'下载文件大小与远端记录不一致，未写入本地',
				)
			checkAbort(signal)
			return download.body
		}
		throw new SyncError('QUARK_URL', '夸克下载重定向次数过多')
	}

	async mkdir(path: string, signal?: AbortSignal) {
		validPath(path)
		let parent = this.rootFolderId
		for (const part of path.split('/')) {
			const matches = (await this.directory(parent, signal)).filter(
				(file) => file.file_name === part,
			)
			if (matches.length > 1 || matches[0]?.file)
				throw new SyncError('PATH_TYPE', '远端目录名称冲突')
			if (matches[0]) parent = matches[0].fid
			else {
				const response = await this.api<{ fid: string }>(
					'/file',
					{
						dir_init_lock: false,
						dir_path: '',
						file_name: part,
						pdir_fid: parent,
					},
					{},
					signal,
				)
				if (!response.data?.fid)
					throw new SyncError('QUARK_SCHEMA', '夸克未返回新目录 ID')
				parent = response.data.fid
			}
		}
	}

	private async rename(id: string, name: string, signal?: AbortSignal) {
		await this.api('/file/rename', { fid: id, file_name: name }, {}, signal)
	}

	private async trash(id: string, signal?: AbortSignal) {
		await this.api(
			'/file/delete',
			{ action_type: 1, exclude_fids: [], filelist: [id] },
			{},
			signal,
		)
	}

	private async waitFor(
		path: string,
		condition: (file: QuarkFile | undefined) => boolean,
		signal?: AbortSignal,
	) {
		for (let attempt = 0; attempt < 8; attempt++) {
			checkAbort(signal)
			const file = await this.find(path, signal)
			if (condition(file)) return file
			await this.pause(150 * (attempt + 1), signal)
		}
		throw new SyncError(
			'REMOTE_PENDING',
			'夸克文件索引尚未完成更新，请稍后重试；原版本或暂存版本已保留',
		)
	}

	private async pause(duration: number, signal?: AbortSignal) {
		checkAbort(signal)
		await new Promise<void>((resolve, reject) => {
			const cancel = () => {
				clearTimeout(timer)
				reject(new SyncError('CANCELLED', '同步已取消'))
			}
			const timer = setTimeout(() => {
				signal?.removeEventListener('abort', cancel)
				resolve()
			}, duration)
			signal?.addEventListener('abort', cancel, { once: true })
		})
	}

	async remove(path: string, expected: FileEntry, signal?: AbortSignal) {
		const current = await this.find(path, signal)
		if (!current?.file || !matchesEntry(this.entry(path, current), expected))
			throw new SyncError('FILE_CHANGED', '远端文件已变化，已取消删除')
		await this.trash(current.fid, signal)
		await this.waitFor(path, (file) => !file, signal)
	}

	private ossUrl(ticket: UploadTicket) {
		const base = new URL(
			ticket.upload_url.startsWith('http:')
				? ticket.upload_url.replace(/^http:/, 'https:')
				: ticket.upload_url,
		)
		if (
			base.protocol !== 'https:' ||
			!(
				base.hostname.endsWith('.aliyuncs.com') ||
				base.hostname === 'pds.quark.cn'
			) ||
			!/^[a-z0-9-]+$/.test(ticket.bucket) ||
			/[\r\n?#]/.test(ticket.obj_key)
		)
			throw new SyncError('QUARK_UPLOAD', '夸克返回了无效的上传目标')
		return new URL(
			`https://${ticket.bucket}.${base.hostname}/${ticket.obj_key}`,
		)
	}

	private async upload(
		name: string,
		parent: string,
		content: Uint8Array,
		signal?: AbortSignal,
	): Promise<string> {
		const mime = 'application/octet-stream'
		const now = Date.now()
		const pre = await this.api<UploadTicket>(
			'/file/upload/pre',
			{
				ccp_hash_update: true,
				dir_name: '',
				file_name: name,
				format_type: mime,
				l_created_at: now,
				l_updated_at: now,
				pdir_fid: parent,
				size: content.byteLength,
			},
			{},
			signal,
		)
		const ticket = pre.data
		if (!ticket?.task_id || !ticket.fid)
			throw new SyncError('QUARK_UPLOAD', '夸克未返回有效上传任务')
		if (ticket && (ticket as UploadTicket & { finish?: boolean }).finish)
			return ticket.fid
		const hashed = await this.api<{ finish: boolean; fid?: string }>(
			'/file/update/hash',
			{
				md5: md5Hex(content),
				sha1: sha1Hex(content),
				task_id: ticket.task_id,
			},
			{},
			signal,
		)
		if (hashed.data.finish) return hashed.data.fid || ticket.fid
		const partSize = pre.metadata?.part_size
		if (!partSize || !Number.isSafeInteger(partSize) || partSize <= 0)
			throw new SyncError('QUARK_UPLOAD', '夸克上传分片大小无效')
		const tags: string[] = []
		const count = Math.max(1, Math.ceil(content.byteLength / partSize))
		const target = this.ossUrl(ticket)
		for (let i = 0; i < count; i++) {
			const date = new Date().toUTCString()
			const authMeta = `PUT\n\n${mime}\n${date}\nx-oss-date:${date}\nx-oss-user-agent:${OSS_AGENT}\n/${ticket.bucket}/${ticket.obj_key}?partNumber=${i + 1}&uploadId=${ticket.upload_id}`
			const auth = await this.api<{ auth_key: string }>(
				'/file/upload/auth',
				{
					auth_info: ticket.auth_info,
					auth_meta: authMeta,
					task_id: ticket.task_id,
				},
				{},
				signal,
			)
			const url = new URL(target)
			url.searchParams.set('partNumber', String(i + 1))
			url.searchParams.set('uploadId', ticket.upload_id)
			const response = await this.transport({
				url: url.toString(),
				method: 'PUT',
				signal,
				body: content.slice(i * partSize, (i + 1) * partSize),
				headers: {
					Authorization: auth.data.auth_key,
					'Content-Type': mime,
					Referer: 'https://pan.quark.cn/',
					'x-oss-date': date,
					'x-oss-user-agent': OSS_AGENT,
				},
			})
			if (
				response.status !== 200 ||
				!response.headers.etag ||
				!/^"?[a-zA-Z0-9-]+"?$/.test(response.headers.etag)
			)
				throw new SyncError('QUARK_UPLOAD', '夸克分片上传失败，未替换原文件')
			tags.push(response.headers.etag)
		}
		const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUpload>\n${tags.map((tag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${tag}</ETag></Part>`).join('\n')}\n</CompleteMultipartUpload>`
		const date = new Date().toUTCString()
		const md5 = md5Base64(encoder.encode(xml))
		const callback = toBase64(encoder.encode(JSON.stringify(ticket.callback)))
		const authMeta = `POST\n${md5}\napplication/xml\n${date}\nx-oss-callback:${callback}\nx-oss-date:${date}\nx-oss-user-agent:${OSS_AGENT}\n/${ticket.bucket}/${ticket.obj_key}?uploadId=${ticket.upload_id}`
		const auth = await this.api<{ auth_key: string }>(
			'/file/upload/auth',
			{
				auth_info: ticket.auth_info,
				auth_meta: authMeta,
				task_id: ticket.task_id,
			},
			{},
			signal,
		)
		target.searchParams.set('uploadId', ticket.upload_id)
		const commit = await this.transport({
			url: target.toString(),
			method: 'POST',
			body: encoder.encode(xml),
			signal,
			headers: {
				Authorization: auth.data.auth_key,
				'Content-MD5': md5,
				'Content-Type': 'application/xml',
				Referer: 'https://pan.quark.cn/',
				'x-oss-callback': callback,
				'x-oss-date': date,
				'x-oss-user-agent': OSS_AGENT,
			},
		})
		if (commit.status !== 200)
			throw new SyncError('QUARK_UPLOAD', '夸克上传提交失败，未替换原文件')
		await this.api(
			'/file/upload/finish',
			{ obj_key: ticket.obj_key, task_id: ticket.task_id },
			{},
			signal,
		)
		return ticket.fid
	}

	async write(
		path: string,
		content: Uint8Array,
		expected: FileEntry | undefined,
		signal?: AbortSignal,
	) {
		validPath(path)
		if (content.byteLength > this.maxFileSize)
			throw new SyncError('FILE_LIMIT', '上传文件超过大小上限')
		if (!matchesEntry(await this.stat(path, signal), expected))
			throw new SyncError('FILE_CHANGED', '远端文件已变化，未开始上传')
		const parts = path.split('/')
		const name = parts.pop()!
		const parentPath = parts.join('/')
		if (parentPath) await this.mkdir(parentPath, signal)
		const parent = parentPath
			? (await this.find(parentPath, signal))!.fid
			: this.rootFolderId
		const stageName = `.vault-sync-upload-${randomUUID()}`
		const stagePath = parentPath ? `${parentPath}/${stageName}` : stageName
		const stageId = await this.upload(stageName, parent, content, signal)
		await this.waitFor(stagePath, (file) => file?.fid === stageId, signal)
		if (sha256(await this.read(stagePath, signal)) !== sha256(content))
			throw new SyncError(
				'VERIFY_FAILED',
				'夸克暂存文件校验失败，原文件保持不变',
			)
		const old = await this.find(path, signal)
		if (!matchesEntry(old ? this.entry(path, old) : undefined, expected))
			throw new SyncError(
				'FILE_CHANGED',
				'远端文件在上传期间变化，保留原文件和暂存文件',
			)
		const backupName = `.vault-sync-backup-${randomUUID()}`
		try {
			if (old) {
				await this.rename(old.fid, backupName, signal)
				await this.waitFor(path, (file) => !file, signal)
			}
			checkAbort(signal)
			await this.rename(stageId, name, signal)
			await this.waitFor(path, (file) => file?.fid === stageId, signal)
		} catch (error) {
			if (old) {
				try {
					const current = await this.find(path)
					if (!current) {
						await this.rename(old.fid, name)
						await this.waitFor(path, (file) => file?.fid === old.fid)
					} else if (current.fid !== old.fid && current.fid !== stageId)
						throw new Error()
				} catch {
					throw new SyncError(
						'ROLLBACK_FAILED',
						'替换失败，旧文件仍在 .vault-sync-backup-* 中，请先恢复后继续',
					)
				}
			}
			throw error
		}
		if (old) await this.trash(old.fid, signal)
	}
}
