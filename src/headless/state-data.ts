import { encode } from './common'
import { validPath } from './paths'
import { FileRecord, SyncError, SyncState } from './types'

export function emptyState(mount: string): SyncState {
	return { version: 1, mount, files: Object.create(null) }
}

export function parseState(text: string, mount: string): SyncState {
	try {
		if (encode(text).byteLength > 32 * 1024 * 1024) throw new Error()
		const state = JSON.parse(text) as SyncState
		if (
			state.version !== 1 ||
			state.mount !== mount ||
			!state.files ||
			typeof state.files !== 'object' ||
			Array.isArray(state.files)
		)
			throw new Error()
		for (const [path, record] of Object.entries(state.files)) {
			validPath(path)
			if (
				!record ||
				!/^[a-f0-9]{64}$/.test(record.hash) ||
				typeof record.remoteRevision !== 'string' ||
				!Number.isSafeInteger(record.size) ||
				record.size < 0 ||
				(record.baseText !== undefined &&
					(typeof record.baseText !== 'string' ||
						encode(record.baseText).byteLength > 64 * 1024))
			)
				throw new Error()
		}
		state.files = Object.assign(Object.create(null), state.files)
		return state
	} catch {
		throw new SyncError(
			'STATE_CORRUPT',
			'同步历史损坏，请保留备份后再处理，未进行文件操作',
		)
	}
}

export function serializeState(state: SyncState) {
	let budget = 16 * 1024 * 1024
	for (const record of Object.values(state.files)) {
		if (record.baseText !== undefined) {
			budget -= encode(record.baseText).byteLength
			if (budget < 0) delete record.baseText
		}
	}
	return JSON.stringify(state) + '\n'
}

export function makeRecord(
	hash: string,
	remoteRevision: string,
	content: Uint8Array,
): FileRecord {
	const record: FileRecord = { hash, remoteRevision, size: content.byteLength }
	if (content.byteLength <= 64 * 1024) {
		try {
			const text = new TextDecoder('utf-8', { fatal: true }).decode(content)
			if (!text.includes('\u0000')) record.baseText = text
		} catch {}
	}
	return record
}
