import { createHash } from 'node:crypto'
import { HttpRequest, HttpResponse, HttpTransport, SyncError } from './types'

interface MockFile {
	fid: string
	file_name: string
	pdir_fid: string
	file: boolean
	size: number
	updated_at: number
	bytes: Uint8Array
}

export class MockQuark {
	uploadEndpoint = 'http://pds.quark.cn'
	files = new Map<string, MockFile>()
	requests: HttpRequest[] = []
	failRename = false
	corruptUpload = false
	beforeFinish?: () => void
	private counter = 0
	private uploads = new Map<
		string,
		{ file: MockFile; parts: Map<number, Uint8Array> }
	>()

	add(path: string, content: string | Uint8Array, directory = false): MockFile {
		const names = path.split('/')
		let parent = 'root'
		for (const name of names.slice(0, -1)) {
			let folder = [...this.files.values()].find(
				(file) => file.pdir_fid === parent && file.file_name === name,
			)
			if (!folder) {
				folder = this.make(name, parent, new Uint8Array(), false)
				this.files.set(folder.fid, folder)
			}
			parent = folder.fid
		}
		const bytes =
			typeof content === 'string' ? new TextEncoder().encode(content) : content
		const file = this.make(names[names.length - 1], parent, bytes, !directory)
		this.files.set(file.fid, file)
		return file
	}

	get(path: string): MockFile | undefined {
		let parent = 'root'
		let found: MockFile | undefined
		for (const name of path.split('/')) {
			found = [...this.files.values()].find(
				(file) => file.pdir_fid === parent && file.file_name === name,
			)
			if (!found) return undefined
			parent = found.fid
		}
		return found
	}

	edit(path: string, text: string) {
		const file = this.get(path)!
		file.bytes = new TextEncoder().encode(text)
		file.size = file.bytes.byteLength
		file.updated_at++
	}

	private make(
		name: string,
		parent: string,
		bytes: Uint8Array,
		file: boolean,
	): MockFile {
		return {
			fid: `file-${++this.counter}`,
			file_name: name,
			pdir_fid: parent,
			bytes,
			file,
			size: bytes.byteLength,
			updated_at: 1700000000000 + this.counter,
		}
	}

	transport: HttpTransport = async (request) => {
		this.requests.push(request)
		const url = new URL(request.url)
		const json = (
			data: unknown,
			extra: Record<string, unknown> = {},
		): HttpResponse => ({
			status: 200,
			headers: {},
			body: new TextEncoder().encode(
				JSON.stringify({ status: 200, code: 0, data, ...extra }),
			),
		})
		if (url.hostname === 'download.quark.cn') {
			const file = this.files.get(url.pathname.slice(1))!
			return { status: 200, headers: {}, body: file.bytes }
		}
		if (
			url.hostname.endsWith('.aliyuncs.com') ||
			url.hostname.endsWith('.pds.quark.cn')
		) {
			if (request.headers?.Cookie) throw new Error('Cookie sent to OSS')
			const task = [...this.uploads.values()].find(
				(item) => item.file.fid === url.pathname.slice(1),
			)!
			if (request.method === 'PUT') {
				const bytes = new Uint8Array(request.body as Uint8Array)
				task.parts.set(Number(url.searchParams.get('partNumber')), bytes)
				return {
					status: 200,
					headers: {
						etag: `"${createHash('md5').update(bytes).digest('hex')}"`,
					},
					body: new Uint8Array(),
				}
			}
			if (
				request.headers?.['Content-MD5'] !==
				createHash('md5')
					.update(request.body as Uint8Array)
					.digest('base64')
			)
				throw new Error('Incorrect XML digest')
			return { status: 200, headers: {}, body: new Uint8Array() }
		}
		const path = url.pathname.replace('/1/clouddrive', '')
		const body =
			typeof request.body === 'string' ? JSON.parse(request.body) : undefined
		if (path === '/config') return json({})
		if (path === '/file/sort') {
			const files = [...this.files.values()].filter(
				(file) => file.pdir_fid === url.searchParams.get('pdir_fid'),
			)
			const page = Number(url.searchParams.get('_page'))
			return json(
				{
					list: files
						.slice((page - 1) * 100, page * 100)
						.map(({ bytes, ...file }) => file),
				},
				{ metadata: { _total: files.length } },
			)
		}
		if (path === '/file/download')
			return json([
				{ download_url: `https://download.quark.cn/${body.fids[0]}` },
			])
		if (path === '/file') {
			const file = this.make(
				body.file_name,
				body.pdir_fid,
				new Uint8Array(),
				false,
			)
			this.files.set(file.fid, file)
			return json({ fid: file.fid })
		}
		if (path === '/file/rename') {
			if (
				this.failRename &&
				!body.file_name.startsWith('.vault-sync-') &&
				this.files.get(body.fid)?.file_name.startsWith('.vault-sync-upload-')
			) {
				this.failRename = false
				throw new SyncError('INJECTED_FAILURE', '测试中的重命名失败')
			}
			this.files.get(body.fid)!.file_name = body.file_name
			return json({})
		}
		if (path === '/file/delete') {
			for (const id of body.filelist) this.files.delete(id)
			return json({})
		}
		if (path === '/file/upload/pre') {
			const file = this.make(
				body.file_name,
				body.pdir_fid,
				new Uint8Array(),
				true,
			)
			this.uploads.set(file.fid, { file, parts: new Map() })
			return json(
				{
					task_id: file.fid,
					fid: file.fid,
					upload_id: 'upload',
					obj_key: file.fid,
					upload_url: this.uploadEndpoint,
					bucket: 'test-bucket',
					auth_info: 'mock-auth-info',
					callback: {
						callbackUrl: 'https://drive.quark.cn/callback',
						callbackBody: 'body',
					},
				},
				{ metadata: { part_size: 3 } },
			)
		}
		if (path === '/file/update/hash') return json({ finish: false })
		if (path === '/file/upload/auth') return json({ auth_key: 'mock-auth-key' })
		if (path === '/file/upload/finish') {
			const task = this.uploads.get(body.task_id)!
			task.file.bytes = Buffer.concat(
				[...task.parts].sort((a, b) => a[0] - b[0]).map(([, bytes]) => bytes),
			)
			if (this.corruptUpload) task.file.bytes[0] ^= 1
			task.file.size = task.file.bytes.byteLength
			this.files.set(task.file.fid, task.file)
			this.beforeFinish?.()
			return json({})
		}
		throw new Error(`Unhandled mock endpoint ${path}`)
	}
}
