import { promises as fs, existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { App } from 'obsidian'

export class TestFile {
	constructor(public path: string) {}
}

export function mobileTestApp(root: string) {
	const path = (value: string) => join(root, value)
	const adapter = {
		getName: () => 'Mobile Test Vault',
		exists: async (value: string) => existsSync(path(value)),
		stat: async (value: string) => {
			try {
				const stat = await fs.lstat(path(value))
				return {
					type: stat.isSymbolicLink()
						? 'symlink'
						: stat.isDirectory()
							? 'folder'
							: 'file',
					size: stat.size,
					mtime: stat.mtimeMs,
					ctime: stat.ctimeMs,
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
				throw error
			}
		},
		list: async (value: string) => {
			const files: string[] = [],
				folders: string[] = []
			for (const item of await fs.readdir(path(value), {
				withFileTypes: true,
			})) {
				const child = value ? `${value}/${item.name}` : item.name
				if (item.isDirectory()) folders.push(child)
				else files.push(child)
			}
			return { files, folders }
		},
		read: (value: string) => fs.readFile(path(value), 'utf8'),
		readBinary: async (value: string) => {
			const data = await fs.readFile(path(value))
			return data.buffer.slice(
				data.byteOffset,
				data.byteOffset + data.byteLength,
			) as ArrayBuffer
		},
		write: (value: string, data: string) => fs.writeFile(path(value), data),
		writeBinary: (value: string, data: ArrayBuffer) =>
			fs.writeFile(path(value), new Uint8Array(data)),
		mkdir: (value: string) => fs.mkdir(path(value)).then(() => undefined),
		rename: async (from: string, to: string) => {
			if (existsSync(path(to))) throw new Error('destination exists')
			await fs.rename(path(from), path(to))
		},
		remove: (value: string) => fs.unlink(path(value)),
		rmdir: (value: string) => fs.rmdir(path(value)),
	}
	const calls: string[] = []
	const vault = {
		adapter,
		configDir: '.obsidian',
		getName: () => 'Mobile Test Vault',
		on() {
			return {}
		},
		getAbstractFileByPath: (value: string) =>
			existsSync(path(value))
				? lstatSync(path(value)).isFile()
					? new TestFile(value)
					: { path: value }
				: null,
		createFolder: async (value: string) => {
			calls.push('createFolder')
			await adapter.mkdir(value)
		},
		createBinary: async (value: string, data: ArrayBuffer) => {
			if (existsSync(path(value))) throw new Error('file exists')
			calls.push('createBinary')
			await adapter.writeBinary(value, data)
		},
		modifyBinary: async (file: TestFile, data: ArrayBuffer) => {
			calls.push('modifyBinary')
			await adapter.writeBinary(file.path, data)
		},
		rename: async (file: TestFile, destination: string) => {
			calls.push('rename')
			await adapter.rename(file.path, destination)
			file.path = destination
		},
	}
	return { app: { vault } as unknown as App, adapter, calls }
}
